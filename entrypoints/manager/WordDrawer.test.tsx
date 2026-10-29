/**
 * 详情抽屉的发音按钮（PLAN.md FR-I1、FR-I1c、FR-I2、FR-I3）。
 *
 * 为什么这一层必须存在：`utils/content/speech.test.ts` 证明的是**判定逻辑**，
 * 但"管理台上有没有这个按钮、点下去到底读的是哪个词形、语速从哪来"
 * 是接线问题——接错了不报错，只是按钮点了没反应（`CONSTRAINTS.md` 第 27 条的同一形状）。
 *
 * jsdom 里没有 Web Speech API，因此这里桩掉 `speechSynthesis` 与
 * `SpeechSynthesisUtterance`：**桩的是浏览器能力，不是被测代码**。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getSettings, setSettings } from '@/utils/db/kv';
import { makeRow } from '@/utils/manager/testing';
import { VOICE_TIMEOUT_MS } from '@/utils/content/speech';
import { WordDrawer } from './WordDrawer';

const LOCAL_US = { name: 'Microsoft Zira', lang: 'en-US', localService: true };
const REMOTE_US = { name: 'Google US English', lang: 'en-US', localService: false };
const LOCAL_GB = { name: 'Daniel', lang: 'en-GB', localService: true };

interface Spoken {
  text: string;
  lang: string;
  rate: number;
  voice: unknown;
}

const spoken: Spoken[] = [];
let voices: Array<{ name: string; lang: string; localService: boolean }> = [];

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  voice: unknown = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** 装一个可控的 Web Speech API（每个用例前调用） */
function installSpeechStub(initialVoices: Array<{ name: string; lang: string; localService: boolean }>) {
  spoken.length = 0;
  voices = initialVoices;

  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = {
    getVoices: () => voices,
    addEventListener: () => {},
    removeEventListener: () => {},
    speak: (utterance: FakeUtterance) =>
      spoken.push({
        text: utterance.text,
        lang: utterance.lang,
        rate: utterance.rate,
        voice: utterance.voice,
      }),
    cancel: () => {},
    speaking: false,
  };
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    FakeUtterance;
}

function renderDrawer() {
  const row = makeRow({
    lemma: 'run',
    surface: 'running',
    phoneticUs: 'rʌn',
    phoneticSrc: 'pipeline',
  });
  return render(<WordDrawer row={row} onClose={() => {}} onChanged={() => {}} />);
}

/** 等一轮微任务：抽屉挂载后要先异步读设置（语速） */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * 点发音并等到"用某个语速读了一次"。
 *
 * ⚠️ 必须等**要断言的那个量**（`spoken` 里的语速），而不是等一个 `flush()`：
 * 抽屉的语速是异步从 IndexedDB 读的，等一轮宏任务在机器忙的时候不够——
 * 那会变成只在并发跑时红的偶发失败（`CONSTRAINTS.md` 第 25 条）。
 * 桩里的 `isSpeaking()` 恒为 false，因此重复点击是安全的。
 */
async function speakUntilRate(rate: number): Promise<void> {
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button', { name: '朗读 run' }));
    expect(spoken.at(-1)?.rate).toBe(rate);
  });
}

describe('FR-I1：管理台也能发音', () => {
  it('有本地美音时出现发音按钮，点击朗读词条原形并带 en-US 与设置里的语速', async () => {
    installSpeechStub([LOCAL_US]);
    await setSettings({ speechRate: 1.5 });
    renderDrawer();

    await speakUntilRate(1.5);

    expect(spoken.at(-1)).toMatchObject({
      text: 'run',
      lang: 'en-US',
      voice: expect.objectContaining({ name: 'Microsoft Zira' }),
    });
    // FR-I1c：voice 必须显式赋上（只设 lang 会被宿主页面的 <html lang> 带偏）
    expect(spoken.at(-1)!.voice).not.toBeNull();
  });

  it('读的是 lemma 而不是 surface（音标列给的是原形的音标）', async () => {
    installSpeechStub([LOCAL_US]);
    renderDrawer();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: '朗读 run' }));

    expect(spoken[0]!.text).toBe('run');
  });
});

describe('FR-I2：语速改动下一次发音即生效', () => {
  it('抽屉打开后改设置，再点发音就用新语速（不重载页面）', async () => {
    installSpeechStub([LOCAL_US]);
    renderDrawer();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: '朗读 run' }));
    expect(spoken.at(-1)!.rate).toBe(1);

    // 同上下文写设置会触发 settings-bus；抽屉据此重读语速
    await act(async () => {
      await setSettings({ speechRate: 0.75 });
    });

    await speakUntilRate(0.75);
    expect((await getSettings()).speechRate).toBe(0.75);
  });
});

describe('FR-I3：无可用本地英文语音时不显示按钮', () => {
  it('加载中就有按钮（首调 getVoices() 返回空是规范允许的，不能提前隐藏）', () => {
    installSpeechStub([]);
    renderDrawer();

    expect(screen.queryByRole('button', { name: '朗读 run' })).not.toBeNull();
  });

  it('超时后仍没有本地美音 → 按钮消失（点了没反应的按钮不该留着）', async () => {
    vi.useFakeTimers();
    try {
      installSpeechStub([REMOTE_US, LOCAL_GB]);
      renderDrawer();

      expect(screen.queryByRole('button', { name: '朗读 run' })).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(VOICE_TIMEOUT_MS + 1);
      });

      expect(screen.queryByRole('button', { name: '朗读 run' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('语音列表在超时前后加载出来就显示按钮（voiceschanged 路径）', async () => {
    const listeners: Array<() => void> = [];
    installSpeechStub([]);
    (window as unknown as { speechSynthesis: { addEventListener: unknown } }).speechSynthesis.addEventListener =
      (_event: string, cb: () => void) => void listeners.push(cb);

    renderDrawer();
    expect(screen.queryByRole('button', { name: '朗读 run' })).not.toBeNull();

    await act(async () => {
      voices = [LOCAL_US];
      for (const listener of listeners) listener();
    });

    // 状态已确定可用：按钮仍在，且此时点击真的会读
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '朗读 run' }));
    await waitFor(() => expect(spoken).toHaveLength(1));
  });
});
