/**
 * 入库后的翻译入队（PLAN.md FR-D1 / FR-D6）。
 *
 * 时机在这一侧而不是翻译 worker 里自己轮询：**只有刚入库那一刻知道"多了哪一句"**。
 * 轮询要么漏（新句子要等下一轮）要么重（每次全表扫）。
 *
 * 三个前提，任一不成立就什么都不做、也不报错：
 *   1. 翻译已启用（配置完整）——`translationEnabled`；
 *   2. 用户已确认告知（句子会离开浏览器）——`translationNoticeAt` 非空；
 *   3. 这次入库确实带了新的例句。
 *
 * ⚠️ 这一层只**入队**，不发网络请求；真正的请求由 `runTranslatePass` 在后台跑。
 * 内容脚本因此仍然零网络（`PLAN.md` §4.2）。
 */
import { getMeta, getSettings } from '../db/kv';
import { getSceneById } from '../db/words';
import { enqueueTranslation } from '../db/translations';
import { translationId } from '../hash';
import { translationEnabled } from './chain';

export interface EnqueueDeps {
  getSettings?: typeof getSettings;
  getMeta?: typeof getMeta;
  getSceneById?: typeof getSceneById;
  enqueue?: typeof enqueueTranslation;
}

export interface EnqueueOutcome {
  /** 是否入队了一条 */
  enqueued: boolean;
  /** 没入队的原因，便于诊断（`disabled` / `no-notice` / `no-scene` / `duplicate`）；入队时为空串 */
  skipped: '' | 'disabled' | 'no-notice' | 'no-scene';
}

/**
 * 把"刚刚入库的那句"送进翻译队列。
 *
 * @param sceneText 这次入库的例句原文（调用方手上就有，不必再回查）
 */
export async function enqueueSceneForTranslation(
  input: { wordId: string; sceneId?: string; sceneText?: string; targetLang: string },
  deps: EnqueueDeps = {},
): Promise<EnqueueOutcome> {
  const readSettings = deps.getSettings ?? getSettings;
  const readMeta = deps.getMeta ?? getMeta;
  const enqueue = deps.enqueue ?? enqueueTranslation;

  // 先看设置：没配置就完全不碰数据库（省一次读）
  const settings = await readSettings();
  if (!translationEnabled(settings.translation)) {
    return { enqueued: false, skipped: 'disabled' };
  }

  const meta = await readMeta();
  if (meta.translationNoticeAt === null) {
    return { enqueued: false, skipped: 'no-notice' };
  }

  const text = input.sceneText?.trim() ?? '';
  if (text === '') {
    return { enqueued: false, skipped: 'no-scene' };
  }

  await enqueue({
    wordId: input.wordId,
    sceneId: input.sceneId ?? input.wordId,
    textHash: translationId(text, input.targetLang, '', ''),
    targetLang: input.targetLang,
  });
  return { enqueued: true, skipped: '' };
}
