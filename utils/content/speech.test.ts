/**
 * 发音的单测（PLAN.md FR-I1、FR-I1a、FR-I1b、FR-I1c、FR-I3）。
 *
 * 四条规格分句在真实浏览器里都很难复现（要凑"只有远程语音"、"只有英音"、
 * "语音列表迟迟不加载"这些环境），所以判定逻辑全部注入化后在这里逐条验收。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSpeech,
  MAX_RATE,
  MIN_RATE,
  pickVoice,
  safeRate,
  SPEECH_LANG,
  type SpeechEnv,
  type SpeechVoiceLike,
} from './speech';

const US_LOCAL: SpeechVoiceLike = {
  name: 'Microsoft Zira',
  lang: 'en-US',
  localService: true,
};
const US_REMOTE: SpeechVoiceLike = { name: 'Google US English', lang: 'en-US', localService: false };
const GB_LOCAL: SpeechVoiceLike = { name: 'Daniel', lang: 'en-GB', localService: true };
const ZH_LOCAL: SpeechVoiceLike = { name: 'Huihui', lang: 'zh-CN', localService: true };

/** 可控的假环境：能手动触发 voiceschanged 与超时 */
function fakeEnv(initial: SpeechVoiceLike[] = []) {
  let voices = initial;
  let speaking = false;
  let onChanged: (() => void) | null = null;
  let timeoutCb: (() => void) | null = null;
  const spoken: Array<{ text: string; voice: SpeechVoiceLike; lang: string; rate: number }> = [];
  const cancel = vi.fn(() => {
    speaking = false;
  });

  const env: SpeechEnv = {
    getVoices: () => voices,
    onVoicesChanged(cb) {
      onChanged = cb;
      return () => {
        if (onChanged === cb) onChanged = null;
      };
    },
    speak(text, voice, lang, rate) {
      spoken.push({ text, voice, lang, rate });
      speaking = true;
    },
    cancel,
    isSpeaking: () => speaking,
    setTimeout(cb) {
      timeoutCb = cb;
      return 1;
    },
    clearTimeout() {
      timeoutCb = null;
    },
  };

  return {
    env,
    spoken,
    cancel,
    /** 模拟浏览器加载完语音列表后派发 voiceschanged */
    load(next: SpeechVoiceLike[]) {
      voices = next;
      onChanged?.();
    },
    /** 模拟超时到点 */
    fireTimeout() {
      timeoutCb?.();
    },
    stopSpeaking() {
      speaking = false;
    },
  };
}

describe('pickVoice：只认本地美音（FR-I1 / FR-I1b）', () => {
  it('挑出 localService === true 的 en-US', () => {
    expect(pickVoice([ZH_LOCAL, US_LOCAL])).toBe(US_LOCAL);
  });

  it('远程语音不算可用（零网络是硬约束）', () => {
    expect(pickVoice([US_REMOTE])).toBeNull();
  });

  it('本地英音不算可用（本项目只提供美音朗读）', () => {
    expect(pickVoice([GB_LOCAL])).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(pickVoice([{ ...US_LOCAL, lang: 'EN-us' }])).not.toBeNull();
  });
});

describe('FR-I1a：必须在 voiceschanged 之后判定，并有超时兜底', () => {
  it('初始是 loading，即使语音列表为空（首调必空是规范允许的）', () => {
    const f = fakeEnv([]);
    const speech = createSpeech(f.env);

    expect(speech.status()).toBe('loading');
  });

  it('voiceschanged 到达后判定为可用', () => {
    const f = fakeEnv([]);
    const speech = createSpeech(f.env);
    expect(speech.status()).toBe('loading');

    f.load([US_LOCAL]);

    expect(speech.status()).toBe('available');
    expect(speech.voice()).toBe(US_LOCAL);
  });

  it('注入时列表已就绪则立即可用，不必等事件', () => {
    const f = fakeEnv([US_LOCAL]);
    expect(createSpeech(f.env).status()).toBe('available');
  });

  it('超时仍无可用语音 → unavailable（FR-I3 的隐藏路径）', () => {
    const f = fakeEnv([US_REMOTE]);
    const speech = createSpeech(f.env);

    f.fireTimeout();

    expect(speech.status()).toBe('unavailable');
  });

  it('超时之后才到货也不改结论（避免按钮闪烁）', () => {
    const f = fakeEnv([]);
    const speech = createSpeech(f.env);
    f.fireTimeout();
    expect(speech.status()).toBe('unavailable');

    f.load([US_LOCAL]);

    expect(speech.status()).toBe('unavailable');
  });

  it('可用性变化会通知订阅者', () => {
    const f = fakeEnv([]);
    const speech = createSpeech(f.env);
    const seen: string[] = [];
    speech.onChange((status) => seen.push(status));

    f.load([US_LOCAL]);

    expect(seen).toEqual(['available']);
  });
});

describe('FR-I1c：必须把选中的 voice 显式赋给 utterance', () => {
  it('朗读时把语音对象与 en-US 一起传下去', () => {
    const f = fakeEnv([US_LOCAL]);
    const speech = createSpeech(f.env);

    speech.speak('running');

    expect(f.spoken).toEqual([
      { text: 'running', voice: US_LOCAL, lang: SPEECH_LANG, rate: 1 },
    ]);
    // 语速走构造参数（FR-I2 的可配入口）
    expect(f.spoken[0]!.lang).toBe('en-US');
  });

  it('空词不朗读', () => {
    const f = fakeEnv([US_LOCAL]);
    createSpeech(f.env).speak('   ');
    expect(f.spoken).toHaveLength(0);
  });

  it('不可用时是空操作，不报错', () => {
    const f = fakeEnv([US_REMOTE]);
    const speech = createSpeech(f.env);
    f.fireTimeout();

    expect(() => speech.speak('run')).not.toThrow();
    expect(f.spoken).toHaveLength(0);
  });
});

describe('FR-A6：已在播放时再次点击为停止（不叠加）', () => {
  it('第二次点击调 cancel，而不是再 speak 一次', () => {
    const f = fakeEnv([US_LOCAL]);
    const speech = createSpeech(f.env);

    speech.speak('run');
    expect(f.spoken).toHaveLength(1);

    speech.speak('run');

    expect(f.spoken).toHaveLength(1);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('stop：解绑监听', () => {
  it('stop 后 voiceschanged 不再改变状态', () => {
    const f = fakeEnv([]);
    const speech = createSpeech(f.env);
    speech.stop();

    f.load([US_LOCAL]);

    expect(speech.status()).toBe('loading');
  });
});

describe('FR-I2：语速可配，下一次发音即生效', () => {
  it('构造参数就是第一次发音用的语速', () => {
    const f = fakeEnv([US_LOCAL]);
    createSpeech(f.env, { rate: 1.5 }).speak('run');

    expect(f.spoken[0]!.rate).toBe(1.5);
  });

  it('setRate 之后下一次发音用新语速，且不需要重建控制器', () => {
    const f = fakeEnv([US_LOCAL]);
    const speech = createSpeech(f.env, { rate: 1 });

    speech.speak('run');
    f.stopSpeaking();
    speech.setRate(2);
    speech.speak('run');

    expect(f.spoken.map((item) => item.rate)).toEqual([1, 2]);
    // 状态没有因为改语速而重新走判定：按钮不该闪
    expect(speech.status()).toBe('available');
  });

  it('越界的语速被钳制到边界（设置可能被手改或旧版本写坏）', () => {
    const f = fakeEnv([US_LOCAL]);
    const speech = createSpeech(f.env, { rate: 99 });

    expect(speech.rate()).toBe(MAX_RATE);
    speech.setRate(0);
    expect(speech.rate()).toBe(MIN_RATE);
    speech.speak('run');
    expect(f.spoken[0]!.rate).toBe(MIN_RATE);
  });

  it('非数字落到默认 1，而不是 NaN 传进 utterance', () => {
    const f = fakeEnv([US_LOCAL]);
    const speech = createSpeech(f.env, { rate: Number('abc') });

    expect(speech.rate()).toBe(1);
    // 能转成数字的垃圾值走**钳制**：空串是 0 → 落到下限（而不是默认值）
    speech.setRate('' as unknown as number);
    expect(speech.rate()).toBe(MIN_RATE);
    speech.setRate('abc' as unknown as number);
    expect(speech.rate()).toBe(1);
    speech.speak('run');
    expect(f.spoken[0]!.rate).toBe(1);
  });

  it('safeRate 的边界：钳制、非数字回默认、自定义 fallback', () => {
    expect(safeRate(1.2)).toBe(1.2);
    expect(safeRate(-5)).toBe(MIN_RATE);
    expect(safeRate(100)).toBe(MAX_RATE);
    expect(safeRate('1.5')).toBe(1.5);
    // 空串能转成数字 0，因此走钳制落到下限；转不成数字的才回默认值
    expect(safeRate('')).toBe(MIN_RATE);
    expect(safeRate('nope')).toBe(1);
    expect(safeRate(Number.NaN)).toBe(1);
    expect(safeRate(undefined, 0.75)).toBe(0.75);
  });
});
