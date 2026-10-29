/**
 * 发音（PLAN.md FR-I1、FR-I1a、FR-I1b、FR-I1c、FR-I3）。
 *
 * 规格把四件事写得很死，且每一条都对应一个真实踩过的坑：
 *
 * | 条款 | 口径 | 不这么做会怎样 |
 * |---|---|---|
 * | FR-I1a | **必须在 `voiceschanged` 触发后判定，并含超时兜底** | 首次调用 `getVoices()` 返回空是规范允许的行为，同步判定会把"加载中"误判成"无语音" |
 * | FR-I1b | **只认 `localService === true` 的英文语音** | 否则会把"运行时零网络"从约定破坏成"发一次云端 TTS 请求" |
 * | FR-I1c | **把选中的 `SpeechSynthesisVoice` 显式赋给 `utterance.voice`** | 只设 `utterance.lang` 时，未设 voice 会继承宿主页面的 `<html lang>`，中文页面上读英文词会被带偏 |
 * | FR-I3 | 判定完成后仍无可用语音 → **隐藏发音按钮**，且**加载中不得隐藏** | 加载中就隐藏会让 Linux 桌面（无语音是常态）与 Windows 表现不一致 |
 *
 * 本模块**不直接摸 `speechSynthesis`**：全部能力由 `SpeechEnv` 注入，因此
 * 上面四条都能在 Node 里逐条验收——真实语音列表只在浏览器里存在。
 */
import type { WordStatus } from '../db/types';

/** 语音可用性的三态。`loading` 与 `unavailable` 是**不同**的：前者不得隐藏按钮 */
export type SpeechStatus = 'loading' | 'available' | 'unavailable';

/** 一条语音的最小信息（只保留判定与赋值需要的字段） */
export interface SpeechVoiceLike {
  name: string;
  lang: string;
  /** 本地合成（不出网）。远程语音一律不用（FR-I1b） */
  localService: boolean;
}

export interface SpeechEnv {
  /** 同步读语音列表。首次可能为空——这是规范允许的，不是错误（FR-I1a） */
  getVoices(): SpeechVoiceLike[];
  /** 订阅 `voiceschanged`；返回解绑函数 */
  onVoicesChanged(cb: () => void): () => void;
  /** 朗读。`voice` 必须被显式赋给 `utterance.voice`（FR-I1c） */
  speak(text: string, voice: SpeechVoiceLike, lang: string, rate: number): void;
  /** 停止当前朗读（FR-A6：已在播放时再次点击为停止，不叠加） */
  cancel(): void;
  /** 当前是否正在朗读 */
  isSpeaking(): boolean;
  /** 超时兜底用的定时器（注入以便单测不真的等） */
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** FR-I1：只提供美音 */
export const SPEECH_LANG = 'en-US';

/**
 * FR-I2 的语速范围与步长。
 *
 * 为什么不是 Chrome 允许的 0.1 ~ 10：0.1 倍速听不出音节边界，5 倍速没有学习意义。
 * 0.5 ~ 2.0（步长 0.1）覆盖了"听不清要放慢"与"太慢要快一点"两种真实需求。
 *
 * ⚠️ 这两条边界有**两个消费者**：设置页的表单校验（`utils/manager/settings-form.ts`）
 * 与运行时的 `safeRate`。**故意共用一个来源**——两边各写一套数字必然慢慢分叉，
 * 表现是"设置页允许 3，实际读出来还是 2"。
 */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const RATE_STEP = 0.1;

/**
 * 把任意输入钳制成合法语速。
 *
 * 设置存在 IndexedDB 里，可能被手改、被旧版本写坏（`"abc"`、`-1`、`500`）。
 * 非法值直接进 `utterance.rate` 的后果由浏览器决定（可能静默用默认值，
 * 也可能抛错），因此这里**一律钳制**：非有限数落到默认 1，越界落到边界。
 */
export function safeRate(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, n));
}

/**
 * 语音可用性的判定超时。
 *
 * 取 1 秒：`voiceschanged` 在真实浏览器里通常在几十毫秒内触发；
 * 等不到也不能一直挂着——按钮的显隐要有个确定答案（FR-I1a 的"超时兜底"）。
 */
export const VOICE_TIMEOUT_MS = 1000;

/**
 * 从语音列表里挑一条可用的美音。
 *
 * 判定顺序（每条都对应规格分句）：
 * 1. `localService === true` —— FR-I1b，把"零网络"变成代码强制
 * 2. `lang` 是 `en-US`（大小写不敏感）—— FR-I1，不做英音朗读
 *
 * ⚠️ `en-GB` 等其它英文变体**不算可用**：规格明写"只提供美音朗读"。
 * 于是英音环境会走到 FR-I3 的隐藏路径——这与 Linux 无语音同属**预期**，
 * 不是缺陷（见 `docs/reference/pronunciation.md`）。
 */
export function pickVoice(voices: readonly SpeechVoiceLike[]): SpeechVoiceLike | null {
  for (const voice of voices) {
    if (voice.localService !== true) continue;
    if (voice.lang.toLowerCase() !== SPEECH_LANG.toLowerCase()) continue;
    return voice;
  }
  return null;
}

export interface Speech {
  /** 当前可用性三态 */
  status(): SpeechStatus;
  /** 选中的语音（不可用时为 null），用于诊断 */
  voice(): SpeechVoiceLike | null;
  /** 可用性变化时通知（FR-I3：判定完成后不可用要隐藏按钮） */
  onChange(cb: (status: SpeechStatus) => void): () => void;
  /** 点一次发音：正在朗读则停止，否则朗读（FR-A6 的"不叠加"） */
  speak(text: string): void;
  /**
   * FR-I2：改语速，**下一次发音即生效**。
   *
   * 为什么不重建整个 `Speech`：重建会重新走一遍语音判定
   * （`loading` → `available`），用户会看到按钮闪一下；
   * 而 FR-I2 要求的只是"下一次发音用新语速"。
   */
  setRate(rate: number): void;
  /** 当前语速（诊断与测试用） */
  rate(): number;
  /** 停止朗读并解绑监听 */
  stop(): void;
}

/**
 * 造一个发音控制器。
 *
 * 生命周期：`loading` →（`voiceschanged` 或超时）→ `available` / `unavailable`。
 * 判定只做一次，之后的 `voiceschanged` 不再改变结论——避免按钮在用户眼前来回闪。
 */
export function createSpeech(env: SpeechEnv, options: { rate?: number; timeoutMs?: number } = {}): Speech {
  let currentRate = safeRate(options.rate ?? 1);
  const timeoutMs = options.timeoutMs ?? VOICE_TIMEOUT_MS;

  let current: SpeechStatus = 'loading';
  let selected: SpeechVoiceLike | null = null;
  let timer: number | null = null;
  let unbind: (() => void) | null = null;
  const listeners = new Set<(status: SpeechStatus) => void>();

  function settle(next: SpeechStatus, voice: SpeechVoiceLike | null): void {
    if (current !== 'loading') return;
    current = next;
    selected = voice;
    clearTimer();
    for (const listener of listeners) listener(current);
  }

  function clearTimer(): void {
    if (timer !== null) {
      env.clearTimeout(timer);
      timer = null;
    }
  }

  /** 判定一次；`voiceschanged` 与超时都走这里 */
  function probe(): void {
    if (current !== 'loading') return;
    const voice = pickVoice(env.getVoices());
    if (voice) {
      settle('available', voice);
      return;
    }
    // 还没有可用语音：可能是列表还没加载完，继续等（超时会兜底）
  }

  unbind = env.onVoicesChanged(probe);
  // 先探一次：有些实现注入时列表就已经就绪，没必要白等一个事件
  probe();
  if (current === 'loading') {
    timer = env.setTimeout(() => {
      timer = null;
      // 超时仍没有可用语音 → 判定为不可用（FR-I1a 的兜底）
      if (!pickVoice(env.getVoices())) settle('unavailable', null);
    }, timeoutMs);
  }

  return {
    status: () => current,
    voice: () => selected,

    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },

    speak(text) {
      const word = text.trim();
      if (word === '') return;
      // FR-A6：已在播放时再次点击为停止，不叠加
      if (env.isSpeaking()) {
        env.cancel();
        return;
      }
      // 加载中按"可能可用"处理：真到不可用时按钮已经被隐藏（FR-I3）
      const voice = selected ?? pickVoice(env.getVoices());
      if (!voice) return;
      selected = voice;
      env.speak(word, voice, SPEECH_LANG, currentRate);
    },

    setRate(next) {
      currentRate = safeRate(next);
    },

    rate: () => currentRate,

    stop() {
      clearTimer();
      unbind?.();
      unbind = null;
      listeners.clear();
    },
  };
}

/** 让 `WordStatus` 的导入留在类型层：卡片里状态与发音共用同一套词状态定义 */
export type { WordStatus };

/**
 * 用真实 Web Speech API 造一个发音环境（FR-I1a ~ FR-I1c）。
 *
 * 为什么它住在这里而不是 `controller.ts`：这是 **Web Speech API 的适配层**，
 * 与"内容脚本控制器"没有关系。管理台的详情抽屉也要发音（FR-I1），
 * 放在 `controller.ts` 里的话，管理台为了一个适配器会把 popup / observer /
 * highlight 整条内容脚本链拉进自己的 chunk。
 *
 * ⚠️ 取回的语音对象是**同一个对象**：`createSpeech` 从 `getVoices()` 里挑，
 * 再原样传回 `speak`，因此这里的反向断言是安全的（不是"按名字重新找一个"——
 * 那样在两条语音同名不同语言时会挑错）。
 */
export function createBrowserSpeechEnv(win: Window = window): SpeechEnv {
  const synth = win.speechSynthesis;

  return {
    getVoices: () => (synth ? synth.getVoices() : []),
    onVoicesChanged(cb) {
      if (!synth) return () => {};
      synth.addEventListener('voiceschanged', cb);
      return () => synth.removeEventListener('voiceschanged', cb);
    },
    speak(text, voice, lang, rate) {
      if (!synth) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = rate;
      // FR-I1c：**必须**把选中的 voice 显式赋上。只设 `lang` 时，未设 voice 的
      // utterance 会继承宿主页面的 `<html lang>` —— 中文页面上读英文词会被带偏。
      utterance.voice = voice as unknown as SpeechSynthesisVoice;
      synth.speak(utterance);
    },
    cancel: () => synth?.cancel(),
    isSpeaking: () => synth?.speaking === true,
    setTimeout: (cb, ms) => win.setTimeout(cb, ms),
    clearTimeout: (handle) => win.clearTimeout(handle),
  };
}
