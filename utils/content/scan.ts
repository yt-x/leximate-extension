/**
 * 文本扫描：从一段文本里找出**所有可标注的词**（PLAN.md FR-A9、FR-A10、FR-A12）。
 *
 * 与 `word.ts` 的分工：
 * - `word.ts` 回答"用户选中的这一段算不算一个词"（划词路径，一次一个）
 * - 本模块回答"这一整段文本里，有哪些位置是生词"（标注路径，一次全扫）
 *
 * 两者共用同一套判定规则（`judgeWord`），因此**划词能查到的词，才可能被标注**——
 * 规则分家会导致"能查到却标不出"或"标了却查不到"的矛盾。
 *
 * 本模块**不碰 DOM**：输入是字符串，输出是字符区间。Range 怎么建是 `highlight.ts` 的事。
 */

import { judgeWord } from './word';

/** 一个可标注的位置：`[from, to)` 是词在文本中的字符范围 */
export interface WordSpan {
  /** 命中的词（原样，未小写化） */
  text: string;
  from: number;
  to: number;
}

/**
 * 词的边界字符：不属于词的字符即边界。
 *
 * 与 `word.ts` 的 `ALLOWED_BODY` 保持一致的口径——字母（含变音符号）、数字、
 * 词内连字符与撇号属于词；其余（空白、标点、中日韩字符）都是边界。
 *
 * **中日韩字符算边界**是有意的：本项目只做英语，中文正文里夹的英文单词要能被找出，
 * 而中文字符本身不该被当成词的一部分（`中文word中文` 应当只标出 `word`）。
 */
const WORD_CHAR = /[\p{Script=Latin}\p{N}'’\-]/u;

/**
 * 从文本中扫出全部候选词。
 *
 * 做法是按"词字符游程"切分，再对每一段用 `judgeWord` 判定。游程切分保证
 * `well-known`、`don't`、`COVID-19` 这类**内部含连字符/撇号**的词不会被拆开
 * （它们在 `WORD_CHAR` 里算词字符）。
 *
 * 为什么复用逐段判定而不是在这里重写一遍规则：FR-A16 的规则表已经逐条单测过，
 * 换个地方重新实现一遍等于把这套测试作废。
 */
export function scanWords(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  let start = -1;

  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i]! : '';
    const isWordChar = i < text.length && WORD_CHAR.test(ch);

    if (isWordChar) {
      if (start === -1) start = i;
      continue;
    }

    // 游程结束
    if (start !== -1) {
      const raw = text.slice(start, i);
      const verdict = judgeWord(raw);
      if (verdict.ok) spans.push({ text: verdict.word, from: start, to: i });
      start = -1;
    }
  }

  return spans;
}

/*
 * ⚠️ 这里曾经有一个 `scanKnownWords(text, isKnown)`——"只留词库里有的词"。
 * 它已经在复核中删除，因为**它编码的判据是错的**：FR-A9 要标的是
 * **本地生词本**里的生词，不是"词典认识的词"。用词典圈候选的后果是
 * "被收藏但词表没收录的词"（`proof` 不在 920 条核心词表里）永远标不出来，
 * 而"词典里有但没收藏的词"反而会被标——实测过的失败形态。
 *
 * 现在标注路径是：`scanWords(text).filter((span) => underlineCount(span.text) !== undefined)`，
 * 集合由后台一次性下发（§4.5 P3），词典只当**词形还原器**。
 * 见 `changes/M1-fix-underline-set.md`、`decisions/0017`、`CONSTRAINTS.md` 第 33 条。
 */
