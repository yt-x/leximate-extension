/**
 * 变形索引的运行时加载（PLAN.md FR-B3a、FR-B3d）。
 *
 * 读 `public/dict/inflections.json`——**扩展包内资源**，
 * 走 `fetch(browser.runtime.getURL(...))`，不出网，因此不违反 §4.2 的"运行时零网络"
 * （与词表分片同一套口径，见 `utils/dict/source.ts` 的说明）。
 *
 * 产物格式与构建脚本 `scripts/build-inflections.ts` 的 `serialize()` 一一对应：
 * ```
 * { version, dictVersion, source, count, entries: { surface: [{ lemma, hint }] } }
 * ```
 */

/** 一个候选原形。`hint` 由构建期算好（"过去式"等），运行时不必再认 QID */
export interface InflectionCandidate {
  lemma: string;
  hint: string;
}

export interface InflectionArtifact {
  version: number;
  dictVersion: string;
  source: string;
  count: number;
  entries: Record<string, InflectionCandidate[]>;
}

/** 当前支持的产物结构版本。与构建脚本的 `ARTIFACT_VERSION` 必须一致 */
export const SUPPORTED_ARTIFACT_VERSION = 1;

/**
 * 解析产物。
 *
 * 校验到"能用"为止：结构对不上就抛，让调用方决定降级——
 * **不静默返回空索引**，否则词形还原会悄悄失效，而用户只会觉得"这插件查不到 running"。
 */
export function parseInflections(text: string): InflectionArtifact {
  const raw = JSON.parse(text) as Partial<InflectionArtifact>;

  if (raw.version !== SUPPORTED_ARTIFACT_VERSION) {
    throw new Error(
      `变形索引版本不兼容：产物为 ${String(raw.version)}，本版本支持 ${SUPPORTED_ARTIFACT_VERSION}`,
    );
  }
  if (typeof raw.entries !== 'object' || raw.entries === null) {
    throw new Error('变形索引格式不对：缺 entries');
  }

  return {
    version: raw.version,
    dictVersion: typeof raw.dictVersion === 'string' ? raw.dictVersion : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    count: typeof raw.count === 'number' ? raw.count : Object.keys(raw.entries).length,
    entries: raw.entries,
  };
}

/**
 * 把产物摊成 `buildReverseIndex` 要的 `InflectionRecord[]`。
 *
 * 注意产物已经**按原形聚合过**（一个 surface 下挂着若干候选），
 * 而 `buildReverseIndex` 收的是扁平的 `{lemma, form, feature}`。
 * 这里用 `hint` 反填 `feature` 字段：`buildReverseIndex` 只用 `feature`
 * 去查提示语，而提示语在构建期已经算好了，直接把 `hint` 当 feature 传进去
 * 会查到空串（`FEATURE_LABELS` 里没有中文键）。
 *
 * 因此这里**不走 `buildReverseIndex`**，而是直接产出运行时需要的索引形态——
 * 少一次无意义的转换，也避免"把 hint 当 QID"这种隐蔽错误。
 */
export function toReverseIndex(
  artifact: InflectionArtifact,
): Map<string, Map<string, Set<string>>> {
  const index = new Map<string, Map<string, Set<string>>>();
  for (const [surface, candidates] of Object.entries(artifact.entries)) {
    const bucket = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      // Set 里放 hint（可能为空串），与 createLemmatizer 的消费方式一致
      bucket.set(candidate.lemma, new Set([candidate.hint]));
    }
    index.set(surface, bucket);
  }
  return index;
}

/** 从扩展包内读产物。`baseUrl` 由调用方给（内容脚本传 `browser.runtime.getURL('dict/')`） */
export async function loadInflections(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InflectionArtifact> {
  const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetchImpl(`${withSlash}inflections.json`);
  if (!response.ok) {
    throw new Error(`读取变形索引失败（HTTP ${response.status}）`);
  }
  return parseInflections(await response.text());
}
