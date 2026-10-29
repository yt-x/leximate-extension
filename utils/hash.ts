/**
 * 快速非加密哈希（FNV-1a 32 位）。
 *
 * 用途：例句去重的 contentHash、翻译缓存的 id。
 * 这些场景要的是稳定与快，不是抗碰撞；真需要抗碰撞时（同步冲突）另说。
 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 同词同句的去重键 */
export function sceneHash(wordId: string, text: string): string {
  return fnv1a(`${wordId}\u0000${text}`);
}

/** 翻译缓存的键：文本 + 目标语言 + 引擎 + 模型 */
export function translationId(
  text: string,
  targetLang: string,
  engine: string,
  model: string,
): string {
  return fnv1a(`${text}\u0000${targetLang}\u0000${engine}\u0000${model}`);
}
