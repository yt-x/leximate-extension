/**
 * 用 CMUdict 生成 `data/core-words.tsv` 的美音音标列。
 *
 * 词表里只有 `pos` 与 `defZh` 是人工撰写的；`phoneticUs` 由本脚本从
 * `data/pronunciation/cmudict.dict` 重算，`phoneticUk` 留空表示暂无英音数据
 * （展示按 `PLAN.md` §3.1 回退美音）。
 *
 *   node scripts/build-phonetics.ts          写入
 *   node scripts/build-phonetics.ts --check  只校验盘上是否与重算结果一致
 *
 * 钉版的 CMUdict 入库是刻意的：它让本脚本在无网络环境也能跑，
 * 音标因此是可复算、可审计的，而不是一次性生成的死数据。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arpaPhonesToIpa, lookupIpa, parseCmudict, wrapIpa } from '../utils/dict/arpabet.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSV_PATH = `${ROOT}data/core-words.tsv`;
const DICT_PATH = `${ROOT}data/pronunciation/cmudict.dict`;
const OVERRIDE_PATH = `${ROOT}data/pronunciation/overrides.tsv`;

const HEADER = 'lemma\tphoneticUs\tphoneticUk\tpos\tdefZh';

interface Row {
  lemma: string;
  phoneticUs: string;
  phoneticUk: string;
  pos: string;
  defZh: string;
  /** 原始行，用于保持列内容逐字不变 */
  raw: string[];
}

function readRows(text: string): Row[] {
  const lines = text.split(/\r?\n/);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split('\t');
    rows.push({
      lemma: cols[0] ?? '',
      phoneticUs: cols[1] ?? '',
      phoneticUk: cols[2] ?? '',
      pos: cols[3] ?? '',
      defZh: cols[4] ?? '',
      raw: cols,
    });
  }
  return rows;
}

function serialize(rows: Row[]): string {
  const body = rows
    .map((r) => [r.lemma, r.phoneticUs, r.phoneticUk, r.pos, r.defZh].join('\t'))
    .join('\n');
  return `${HEADER}\n${body}\n`;
}

/**
 * 读人工覆盖表。同形异音词（read / live / wind 这类）取 CMUdict 的首变体会拿到
 * 不匹配释义的那个读音，必须逐词指定。
 */
function readOverrides(): Map<string, { ipa: string; reason: string }> {
  const out = new Map<string, { ipa: string; reason: string }>();
  const text = readFileSync(OVERRIDE_PATH, 'utf8');
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [lemma, ipa, reason] = line.split('\t');
    if (!lemma || !ipa) continue;
    out.set(lemma, { ipa, reason: reason ?? '' });
  }
  return out;
}

function main(): void {
  const check = process.argv.includes('--check');

  const dict = parseCmudict(readFileSync(DICT_PATH, 'utf8'));
  const overrides = readOverrides();
  const rows = readRows(readFileSync(TSV_PATH, 'utf8'));

  const missing: string[] = [];
  const unresolved: string[] = [];
  const badOverrides: string[] = [];
  const appliedOverrides: string[] = [];
  let changed = 0;

  for (const row of rows) {
    const override = overrides.get(row.lemma);
    let generated: string | null;
    if (override) {
      // 覆盖值必须确实是 CMUdict 列出的某个变体，防止手写错误混进成品
      const variants = (dict.get(row.lemma) ?? [])
        .map((p) => {
          const body = arpaPhonesToIpa(p);
          return body === null ? null : wrapIpa(body);
        })
        .filter((x): x is string => x !== null);
      if (!variants.includes(override.ipa)) {
        badOverrides.push(`${row.lemma}: ${override.ipa} 不在 CMUdict 变体里`);
        continue;
      }
      generated = override.ipa;
      appliedOverrides.push(row.lemma);
    } else {
      generated = lookupIpa(dict, row.lemma);
    }

    if (generated === null) {
      if (!dict.has(row.lemma)) missing.push(row.lemma);
      else unresolved.push(row.lemma);
      continue;
    }
    if (row.phoneticUs !== generated) changed++;
    row.phoneticUs = generated;
    row.phoneticUk = ''; // 暂无英音数据
  }

  const next = serialize(rows);
  const current = readFileSync(TSV_PATH, 'utf8');
  const identical = current === next;
  const failed = missing.length > 0 || unresolved.length > 0 || badOverrides.length > 0;

  if (check && !identical) {
    console.log(
      JSON.stringify(
        {
          check: true,
          drift: 1,
          entries: rows.length,
          phoneticsChanged: changed,
          missingInCmudict: missing.length,
          unresolvedPhones: unresolved.length,
          badOverrides,
          sample: { missing: missing.slice(0, 10), unresolved: unresolved.slice(0, 10) },
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (!check && !identical) writeFileSync(TSV_PATH, next, 'utf8');

  console.log(
    JSON.stringify(
      {
        source: 'data/pronunciation/cmudict.dict',
        target: 'data/core-words.tsv',
        entries: rows.length,
        phoneticsChanged: changed,
        missingInCmudict: missing.length,
        unresolvedPhones: unresolved.length,
        overridesApplied: appliedOverrides.length,
        overridesUnused: [...overrides.keys()].filter((k) => !appliedOverrides.includes(k)),
        badOverrides,
        wrote: !check && !identical,
        drift: identical ? 0 : 1,
        sample: { missing: missing.slice(0, 10), unresolved: unresolved.slice(0, 10) },
      },
      null,
      2,
    ),
  );

  if (failed) process.exit(1);
}

main();
