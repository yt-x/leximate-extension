/**
 * 单词详情抽屉（PLAN.md FR-F7）。
 *
 * 展示全部释义、全部例句 + 翻译、来源链接、音标、发音。
 *
 * **不丢列表状态**（FR-F7 的验收）：抽屉是覆盖层，列表组件始终挂载着，
 * 因此 `scrollTop`、筛选、排序、选中集天然不变——
 * 这是"用覆盖层而不是换页"的直接收益，不是额外补偿逻辑。
 */
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Scene, WordStatus } from '@/utils/db/types';
import { getSettings } from '@/utils/db/kv';
import { listScenesByWord, updateWordStatus } from '@/utils/db/words';
import { createDataChangeNotifier } from '@/utils/manager/data-changed';
import { onSettingsWritten } from '@/utils/settings-bus';
import {
  createBrowserSpeechEnv,
  createSpeech,
  type Speech,
  type SpeechStatus,
} from '@/utils/content/speech';
import type { ListRow } from '@/utils/manager/filter';
import { tx } from '@/utils/i18n';

/** FR-L1：标签在渲染期取，不能在模块顶层算死（语言切换后要跟着变） */
function statusLabel(status: WordStatus): string {
  return tx(status === 'new' ? '生词' : status === 'known' ? '已掌握' : '忽略');
}

export function WordDrawer({
  row,
  onClose,
  onChanged,
}: {
  row: ListRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loading, setLoading] = useState(true);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>('loading');
  const speechRef = useRef<Speech | null>(null);

  /**
   * 发音（FR-I1 ~ FR-I3）。
   *
   * 三条约定都在这里落地，且**与内容脚本弹窗共用同一套实现**
   * （`createSpeech` + `createBrowserSpeechEnv`）——复制一份判定必然分叉，
   * 表现是"弹窗上按 FR-I3 隐藏了，抽屉里照旧显示一个点了没反应的按钮"。
   *
   * - FR-I2：语速来自设置；设置页改完（同上下文会触发 `settings-bus`）立刻用新值，
   *   不需要重载页面
   * - FR-I3：只有**确定**没有可用本地英文语音时才不渲染按钮；加载中必须显示
   * - 卸载时 `stop()`：不停掉的话，关掉抽屉后语音会继续读完
   */
  useEffect(() => {
    const speech = createSpeech(createBrowserSpeechEnv(window));
    speechRef.current = speech;
    setSpeechStatus(speech.status());

    const unbindStatus = speech.onChange(setSpeechStatus);
    const readRate = () => {
      void getSettings()
        .then((settings) => speech.setRate(settings.speechRate))
        .catch(() => {
          // 读不到设置就用默认语速：发音不该因为设置读失败而不可用
        });
    };
    readRate();
    const unbindSettings = onSettingsWritten(readRate);

    return () => {
      unbindStatus();
      unbindSettings();
      speech.stop();
      speechRef.current = null;
    };
  }, []);

  useEffect(() => {
    // 切换单词时重新取例句；用 cancelled 防止旧请求回来覆盖新词的数据
    let cancelled = false;
    setLoading(true);
    void listScenesByWord(row.word.id).then((list) => {
      if (cancelled) return;
      setScenes(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [row.word.id]);

  // Esc 关闭：抽屉是模态的，键盘用户需要退路
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { word } = row;

  const changeStatus = async (status: WordStatus) => {
    await updateWordStatus(word.id, status);
    // FR-A14：管理台与后台是两个页面，改完库要显式通知后台重算角标
    void createDataChangeNotifier({
      sendToBackground: (message) => browser.runtime.sendMessage(message),
    })();
    onChanged();
  };

  return (
    <div
      className="drawer-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={tx('{surface} 详情', { surface: word.surface })}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <h2>{word.surface}</h2>
            {word.lemma !== word.surface.toLowerCase() && (
              <div className="muted">{tx('原形：{lemma}', { lemma: word.lemma })}</div>
            )}
          </div>
          <button onClick={onClose} aria-label={tx('关闭')}>
            {tx('关闭')}
          </button>
        </div>

        <section>
          <h3>{tx('音标')}</h3>
          <p style={{ margin: 0 }}>
            {word.phoneticUs ? (
              <>
                {tx('美 /{ipa}/', { ipa: word.phoneticUs })} <span className="muted">{tx('来源：{src}', { src: word.phoneticSrc ?? tx('未标注') })}</span>
              </>
            ) : (
              <span className="muted">{tx('无音标')}</span>
            )}
          </p>
          {/* FR-I1：管理台也能发音；FR-I3：确定没有可用本地英文语音时不显示这个按钮
              （加载中要显示——首调 getVoices() 返回空是规范允许的行为）。
              朗读的是 `lemma`：音标列给的是原形的音标，读 surface 会出现
              "显示 /rʌn/ 却读 running"的不一致。 */}
          {speechStatus !== 'unavailable' && (
            <button
              onClick={() => speechRef.current?.speak(word.lemma)}
              aria-label={tx('朗读 {lemma}', { lemma: word.lemma })}
              style={{ marginTop: 6 }}
            >
              {tx('发音')}
            </button>
          )}
        </section>

        <section>
          <h3>{tx('释义')}</h3>
          {word.defZh.length > 0 ? (
            <ul>
              {word.defZh.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : word.fallbackDef.length > 0 ? (
            <>
              <ul>
                {word.fallbackDef.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
              <p className="hint">{tx('以上为导入时保留的原平台释义')}</p>
            </>
          ) : (
            <p className="muted">{word.isUnlisted ? tx('词库未收录') : tx('暂无释义')}</p>
          )}
          <p className="hint">
            {tx('来源：{src}', { src: word.defSrc ?? tx('未标注') })}
            {word.pos.length > 0 ? tx(' · 词性：{pos}', { pos: word.pos.join('、') }) : ''}
          </p>
        </section>

        <section>
          <h3>{tx('状态')}</h3>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {(['new', 'known', 'ignored'] as WordStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => void changeStatus(s)}
                disabled={word.status === s}
                aria-pressed={word.status === s}
              >
                {statusLabel(s)}
              </button>
            ))}
            <span className="muted">{tx('遇见 {count} 次', { count: word.meetCount })}</span>
          </div>
        </section>

        <section>
          <h3>{tx('例句（{count}）', { count: row.sceneCount })}</h3>
          {loading ? (
            <p className="muted">{tx('加载中…')}</p>
          ) : scenes.length === 0 ? (
            <p className="muted">{tx('还没有例句')}</p>
          ) : (
            scenes.map((scene) => (
              <div className="scene" key={scene.id}>
                <div>
                  {/* 划词位置高亮：用原文切片，不注入 HTML（避免 XSS 面） */}
                  {scene.text.slice(0, scene.highlightFrom)}
                  <mark>{scene.text.slice(scene.highlightFrom, scene.highlightTo)}</mark>
                  {scene.text.slice(scene.highlightTo)}
                </div>
                {scene.translation && (
                  <div className="muted" style={{ marginTop: 2 }}>
                    {scene.translation}
                  </div>
                )}
                <div className="src">
                  {scene.domain || tx('未知来源')}
                  {scene.sourceUrl && (
                    <>
                      {' · '}
                      {/* 列表里只放链接文本，不自动打开——用户点击才跳 */}
                      <a href={scene.sourceUrl} target="_blank" rel="noreferrer">
                        {tx('原页面')}
                      </a>
                    </>
                  )}
                  {' · '}
                  {new Date(scene.capturedAt).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
