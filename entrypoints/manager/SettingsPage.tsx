/**
 * 设置页（PLAN.md FR-F9）。
 *
 * 校验与序列化在 `utils/manager/settings-form.ts`（纯函数，有单测）；
 * 本组件只管取值、显示错误、保存。
 *
 * **保存后立即反映到行为**：`setSettings` 内部会触发 `notifySettingsWritten`，
 * 后台据此刷新角标并用 `tabs.sendMessage` 通知各内容脚本
 * （见 `decisions/0010`）。下划线样式类需重载页面，因为 CSS 是在注入时注册的
 * （FR-A11 的已知边界）。
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { getSettings, setSettings } from '@/utils/db/kv';
import { tx } from '@/utils/i18n';
import { LIMIT_MAX, LIMIT_MIN } from '@/utils/translate/chain';
import { countScenes, countWords } from '@/utils/db/words';
import { clearAllData, readDataHealth, type DataHealth } from '@/utils/db/maintenance';
import { formatBytes, storageStatus } from '@/utils/manager/backup-health';
import { createDataChangeNotifier } from '@/utils/manager/data-changed';
import { notifyWordsChanged, onWordsChanged } from '@/utils/manager/words-bus';
import { MAX_RATE, MIN_RATE, RATE_STEP } from '@/utils/content/speech';
import { ImportSection } from './ImportSection';
import { DictionarySection } from './DictionarySection';
import { browserDictionaryDeps } from './dictionary-deps';
import { TranslateStatus } from './TranslateStatus';
import { SyncStatus } from './SyncStatus';
import type { Settings, WordStatus } from '@/utils/db/types';
import {
  applyForm,
  formatBlacklist,
  hasErrors,
  parseBlacklist,
  validateSettingsForm,
  type SettingsFormErrors,
} from '@/utils/manager/settings-form';

/** FR-L1：状态标签在渲染期取（语言切换后要跟着变） */
function statusLabel(status: WordStatus): string {
  return tx(status === 'new' ? '生词' : status === 'known' ? '已掌握' : '忽略');
}

/**
 * 通知后台「数据变了」→ 后台重算角标（FR-A14）。
 *
 * **管理台与后台是两个上下文**：`setSettings` 里的 `notifySettingsWritten`
 * 只派发给同一上下文内的监听者，后台（Service Worker）收不到。
 * 凡是管理台改了会影响角标的东西（设置里的全局开关、清空数据…），都要显式发这条。
 */
const notifyDataChanged = createDataChangeNotifier({
  sendToBackground: (message) => browser.runtime.sendMessage(message),
});

const STATUS_ORDER: readonly WordStatus[] = ['new', 'known', 'ignored'];

export interface SettingsPageProps {
  /**
   * FR-L1：语言保存后通知外壳切换。
   *
   * 为什么不在选择时就切：本页的契约是"改完点保存"，语言与其它字段同一个语义；
   * 立刻切换会让"没保存就变了"与表单状态不一致。
   */
  onLocaleChange?(language: Settings['ui']['language']): void;
}

export function SettingsPage({ onLocaleChange }: SettingsPageProps = {}) {
  const [form, setForm] = useState<Settings | null>(null);
  const [blacklistText, setBlacklistText] = useState('');
  const [errors, setErrors] = useState<SettingsFormErrors>({});
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** FR-L5 的体积自检事实（真实配额查询；读不到时保持为空，不编数字） */
  const [health, setHealth] = useState<DataHealth | null>(null);

  /**
   * FR-E7 的二次确认状态。
   *
   * 规格口径（与 FR-F6 的批量删除一致）：**在界面内展示将要删除的条数并要求再点一次**，
   * 不用 `window.confirm`——它在扩展页会被部分环境拦截，且无法测。
   */
  const [clearStep, setClearStep] = useState<'idle' | 'confirm' | 'done'>('idle');
  const [clearCounts, setClearCounts] = useState<{ words: number; scenes: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  useEffect(() => {
    void getSettings()
      .then((s) => {
        setForm(s);
        setBlacklistText(formatBlacklist(s.blacklist));
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  /**
   * FR-L5：体积自检的事实来源。
   *
   * 订阅同上下文总线：清空数据、导入、改状态之后占用与条数都会变，
   * 这里跟着重读一次（不订阅的话设置页会一直显示打开那一刻的数字）。
   */
  useEffect(() => {
    let alive = true;
    const load = () => {
      void readDataHealth()
        .then((next) => {
          if (alive) setHealth(next);
        })
        .catch(() => {
          // 读不到就保持"未知"，不编数字
        });
    };
    load();
    const unbind = onWordsChanged(load);
    return () => {
      alive = false;
      unbind();
    };
  }, []);

  if (loadError) return <p className="error">{tx('读取设置失败：{error}', { error: loadError })}</p>;
  if (!form) return <p className="muted">{tx('加载中…')}</p>;

  const storage = storageStatus(health ?? { usage: null, quota: null });

  const patch = (over: Partial<Settings>) => {
    setForm((f) => (f ? { ...f, ...over } : f));
    setSaved(false);
  };

  const save = async () => {
    // 黑名单以文本编辑，保存前解析成数组
    const next: Settings = { ...form, blacklist: parseBlacklist(blacklistText) };
    const found = validateSettingsForm(next);
    setErrors(found);
    if (hasErrors(found)) return;

    const current = await getSettings();
    await setSettings(applyForm(current, next));
    // **通知后台重算角标**（FR-A14）：管理台与后台是两个上下文，
    // `setSettings` 里的 `notifySettingsWritten` 只通知本上下文，后台收不到——
    // 少了这一句，关掉全局开关后角标要等后台因别的原因被唤醒才变 OFF（用户实测：延迟很久）。
    void notifyDataChanged();
    setForm(next);
    setBlacklistText(formatBlacklist(next.blacklist));
    setSaved(true);
    // FR-L1：语言按"保存后生效"，与其它字段同一个语义
    onLocaleChange?.(next.ui.language);
  };

  /** 第一步：只统计与提示，**不动数据**（验收："未确认时不执行"） */
  const askClear = async () => {
    setClearError(null);
    setClearStep('confirm');
    setClearCounts(null);
    try {
      const [words, scenes] = await Promise.all([countWords(), countScenes()]);
      setClearCounts({ words, scenes });
    } catch (e) {
      setClearError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 第二步：真的清（FR-E7 = 数据清空、**设置保留**） */
  const confirmClear = async () => {
    setClearing(true);
    setClearError(null);
    try {
      await clearAllData();
      // 后台重算角标（管理台与后台是两个上下文，必须显式通知）
      void notifyDataChanged();
      // 同上下文里的列表页要重新读库（两个页面同时挂载，见 App.tsx）
      notifyWordsChanged();
      setClearStep('done');
    } catch (e) {
      setClearError(e instanceof Error ? e.message : String(e));
      setClearStep('confirm');
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <h2 style={{ fontSize: '1.05rem' }}>{tx('设置')}</h2>

      <div className="settings-grid">
        <label htmlFor="s-enabled">{tx('全局开关')}</label>
        <div>
          <input
            id="s-enabled"
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <div className="hint">{tx('关闭后不注入、不标注，角标显示 OFF')}</div>
        </div>

        <label htmlFor="s-style">{tx('下划线样式')}</label>
        <div>
          <select
            id="s-style"
            value={form.underlineStyle}
            onChange={(e) => patch({ underlineStyle: e.target.value as Settings['underlineStyle'] })}
          >
            <option value="dotted">{tx('点线')}</option>
            <option value="solid">{tx('实线')}</option>
            <option value="wavy">{tx('波浪')}</option>
            <option value="none">{tx('无下划线')}</option>
          </select>
          {errors.underlineStyle && <div className="field-error">{errors.underlineStyle}</div>}
          <div className="hint">{tx('样式类改动需重载页面生效（CSS 在注入时注册）')}</div>
        </div>

        <label htmlFor="s-color">{tx('下划线颜色')}</label>
        <div>
          <input
            id="s-color"
            type="text"
            value={form.underlineColor}
            onChange={(e) => patch({ underlineColor: e.target.value })}
          />
          {errors.underlineColor && <div className="field-error">{errors.underlineColor}</div>}
        </div>

        <label htmlFor="s-thickness">{tx('线宽（px）')}</label>
        <div>
          <input
            id="s-thickness"
            type="number"
            step="0.5"
            value={form.underlineThickness}
            onChange={(e) => patch({ underlineThickness: Number(e.target.value) })}
          />
          {errors.underlineThickness && (
            <div className="field-error">{errors.underlineThickness}</div>
          )}
        </div>

        <label htmlFor="s-reflect">{tx('按遇见次数变化')}</label>
        <div>
          <input
            id="s-reflect"
            type="checkbox"
            checked={form.reflectMeetCount}
            onChange={(e) => patch({ reflectMeetCount: e.target.checked })}
          />
          <div className="hint">{tx('遇见越多，线条越粗（分 5 档）')}</div>
        </div>

        <label htmlFor="s-minlen">{tx('最短词长')}</label>
        <div>
          <input
            id="s-minlen"
            type="number"
            value={form.minWordLength}
            onChange={(e) => patch({ minWordLength: Number(e.target.value) })}
          />
          {errors.minWordLength && <div className="field-error">{errors.minWordLength}</div>}
          <div className="hint">{tx('短于该长度的选中词不处理')}</div>
        </div>

        <label htmlFor="s-auto">{tx('选中即入库')}</label>
        <div>
          <input
            id="s-auto"
            type="checkbox"
            checked={form.autoAddOnSelect}
            onChange={(e) => patch({ autoAddOnSelect: e.target.checked })}
          />
          <div className="hint">
            {tx('默认关闭：划词只弹卡片，由你点「加入生词本」才收藏。打开后划词即入库（会被频繁的误选触发，因此不推荐）')}
          </div>
        </div>

        {/* FR-L1：界面语言。只管管理台，弹窗不参与（口径见 decisions/0026） */}
        <label htmlFor="s-language">{tx('界面语言')}</label>
        <div>
          <select
            id="s-language"
            value={form.ui.language}
            onChange={(e) => patch({ ui: { ...form.ui, language: e.target.value as Settings['ui']['language'] } })}
          >
            <option value="auto">{tx('跟随浏览器')}</option>
            <option value="zh-CN">{tx('中文')}</option>
            <option value="en">English</option>
          </select>
          {errors.language && <div className="field-error">{errors.language}</div>}
          <div className="hint">{tx('只影响管理台界面；划词弹窗不随此项变化。保存后生效。')}</div>
        </div>

        <label htmlFor="s-rate">{tx('发音语速')}</label>
        <div>
          <input
            id="s-rate"
            type="number"
            min={MIN_RATE}
            max={MAX_RATE}
            step={RATE_STEP}
            value={form.speechRate}
            onChange={(e) => patch({ speechRate: Number(e.target.value) })}
          />
          {errors.speechRate && <div className="field-error">{errors.speechRate}</div>}
          <div className="hint">
            {tx('{min} ~ {max}，1 为正常语速。改完下一次发音即生效，不需要重载页面', { min: MIN_RATE, max: MAX_RATE })}
            {tx('（FR-I2）；机器上没有可用的本地英文语音时不显示发音按钮（FR-I3）')}
          </div>
        </div>

        {/* FR-D5：成本控制三项可配。放在这里是因为它们是"翻译要花多少钱"的那一面 */}
        <label htmlFor="s-limit-batch">{tx('翻译批量与上限')}</label>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>
              {tx('单批条数')}
            </span>
            <input
              id="s-limit-batch"
              type="number"
              min={LIMIT_MIN.batchSize}
              max={LIMIT_MAX.batchSize}
              value={form.translation.limits.batchSize}
              onChange={(e) =>
                patch({
                  translation: {
                    ...form.translation,
                    limits: { ...form.translation.limits, batchSize: Number(e.target.value) },
                  },
                })
              }
            />
            <label htmlFor="s-limit-concurrency" className="muted" style={{ fontSize: '.8rem' }}>
              {tx('并发数')}
            </label>
            <input
              id="s-limit-concurrency"
              type="number"
              min={LIMIT_MIN.concurrency}
              max={LIMIT_MAX.concurrency}
              value={form.translation.limits.concurrency}
              onChange={(e) =>
                patch({
                  translation: {
                    ...form.translation,
                    limits: { ...form.translation.limits, concurrency: Number(e.target.value) },
                  },
                })
              }
            />
            <label htmlFor="s-limit-daily" className="muted" style={{ fontSize: '.8rem' }}>
              {tx('每日上限')}
            </label>
            <input
              id="s-limit-daily"
              type="number"
              min={LIMIT_MIN.dailyLimit}
              max={LIMIT_MAX.dailyLimit}
              value={form.translation.limits.dailyLimit}
              onChange={(e) =>
                patch({
                  translation: {
                    ...form.translation,
                    limits: { ...form.translation.limits, dailyLimit: Number(e.target.value) },
                  },
                })
              }
            />
          </div>
          {errors.limits && <div className="field-error">{errors.limits}</div>}
          <div className="hint">
            {tx('超过每日上限时排队等待，不会丢；填 0 表示暂停翻译。')}
          </div>
        </div>

        <label htmlFor="s-blacklist">{tx('站点黑名单')}</label>
        <div>
          <textarea
            id="s-blacklist"
            value={blacklistText}
            onChange={(e) => {
              setBlacklistText(e.target.value);
              setSaved(false);
            }}
            placeholder={tx('每行一个域名后缀，例如：\nexample.com\nmail.google.com')}
          />
          {errors.blacklist && <div className="field-error">{errors.blacklist}</div>}
          <div className="hint">{tx('这些域名下不注入、不标注。填裸域名，不要带 https:// 或路径')}</div>
        </div>

        {/* ⚠️ 「界面语言 / 主题 / 每页条数」三个控件此前在这里，但**没有任何消费者**
            （复核时实测：只有写它们的这个表单在读）。按本页既定的原则——
            "不放不可用的假开关"——撤下界面，列在下方"尚未启用的设置"里说明原因。
            字段留在数据模型里，已保存的值不会丢；要放回来，先让它们真的被读，
            并在 `utils/settings-wiring.test.ts` 的登记表里改分类。 */}

        <label htmlFor="s-engine">{tx('翻译引擎')}</label>
        <div>
          <select
            id="s-engine"
            value={form.translation.engine}
            onChange={(e) =>
              patch({
                translation: {
                  ...form.translation,
                  engine: e.target.value as Settings['translation']['engine'],
                },
              })
            }
          >
            <option value="chrome-builtin">{tx('浏览器内置（无需配置）')}</option>
            <option value="llm">{tx('LLM（需填接口与 Key）')}</option>
            <option value="api">{tx('自建接口')}</option>
          </select>
          {errors.engine && <div className="field-error">{errors.engine}</div>}
          {form.translation.engine === 'chrome-builtin' && (
            <div className="hint">
              {tx('Chrome 内置翻译仅在部分版本可用；不可用时自动降级（§4.5 的三级兜底）')}
            </div>
          )}
          {form.translation.engine === 'llm' && (
            <>
              <input
                style={{ width: '100%', marginTop: 6 }}
                placeholder={tx('接口地址，如 https://api.example.com/v1')}
                value={form.translation.llm?.baseUrl ?? ''}
                onChange={(e) =>
                  patch({
                    translation: {
                      ...form.translation,
                      llm: {
                        baseUrl: e.target.value,
                        apiKey: form.translation.llm?.apiKey ?? '',
                        model: form.translation.llm?.model ?? '',
                      },
                    },
                  })
                }
              />
              {errors.llmBaseUrl && <div className="field-error">{errors.llmBaseUrl}</div>}
              <input
                style={{ width: '100%', marginTop: 6 }}
                type="password"
                placeholder="API Key"
                value={form.translation.llm?.apiKey ?? ''}
                onChange={(e) =>
                  patch({
                    translation: {
                      ...form.translation,
                      llm: {
                        baseUrl: form.translation.llm?.baseUrl ?? '',
                        apiKey: e.target.value,
                        model: form.translation.llm?.model ?? '',
                      },
                    },
                  })
                }
              />
              {errors.llmApiKey && <div className="field-error">{errors.llmApiKey}</div>}
              <input
                style={{ width: '100%', marginTop: 6 }}
                placeholder={tx('模型名（可选）')}
                value={form.translation.llm?.model ?? ''}
                onChange={(e) =>
                  patch({
                    translation: {
                      ...form.translation,
                      llm: {
                        baseUrl: form.translation.llm?.baseUrl ?? '',
                        apiKey: form.translation.llm?.apiKey ?? '',
                        model: e.target.value,
                      },
                    },
                  })
                }
              />
            </>
          )}
          {form.translation.engine === 'api' && (
            <>
              <input
                style={{ width: '100%', marginTop: 6 }}
                placeholder={tx('自建接口地址')}
                value={form.translation.api?.url ?? ''}
                onChange={(e) =>
                  patch({
                    translation: {
                      ...form.translation,
                      api: { url: e.target.value, headers: form.translation.api?.headers ?? {} },
                    },
                  })
                }
              />
              {errors.apiUrl && <div className="field-error">{errors.apiUrl}</div>}
            </>
          )}
        </div>

        <label htmlFor="s-targetlang">{tx('目标语言')}</label>
        <div>
          <input
            id="s-targetlang"
            value={form.translation.targetLang}
            onChange={(e) =>
              patch({ translation: { ...form.translation, targetLang: e.target.value } })
            }
          />
          {errors.targetLang && <div className="field-error">{errors.targetLang}</div>}
        </div>
      </div>

      <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={() => void save()}>{tx('保存设置')}</button>
        {saved && <span className="saved">{tx('已保存')}</span>}
        {hasErrors(errors) && <span className="error">{tx('有 {n} 项需要修正', { n: Object.keys(errors).length })}</span>}
      </div>

      <section style={{ marginTop: 26, maxWidth: 720 }}>
        <h3 style={{ fontSize: '.85rem', color: 'var(--muted)' }}>{tx('数据')}</h3>

        {/* FR-E7：一键清空所有数据（二次确认在界面内完成，不用 window.confirm） */}
        <div style={{ marginTop: 8 }}>
          {clearStep !== 'confirm' && (
            <button onClick={() => void askClear()}>{tx('清空所有数据')}</button>
          )}

          {clearStep === 'confirm' && (
            <div className="danger" role="alertdialog" aria-label={tx('确认清空所有数据')}>
              <p style={{ margin: '0 0 8px' }}>
                {clearCounts
                  ? tx('确认清空？将删除 {words} 个词、{scenes} 条例句。', { words: clearCounts.words, scenes: clearCounts.scenes })
                  : tx('确认清空？正在统计将要删除的条数…')}
                <br />
                <strong>{tx('设置会保留')}</strong>；数据只在本机，删掉无法恢复（建议先导出备份）。
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={() => void confirmClear()} disabled={clearing}>
                  {clearing ? tx('清空中…') : tx('确认清空')}
                </button>
                <button onClick={() => setClearStep('idle')} disabled={clearing}>
                  {tx('取消')}
                </button>
              </div>
            </div>
          )}

          {clearStep === 'done' && (
            <p className="saved" style={{ marginTop: 8 }}>
              {tx('已清空。设置保留；角标也已同步。')}
            </p>
          )}

          {clearError && <div className="field-error">{tx('清空失败：{error}', { error: clearError })}</div>}

          <div className="hint">
            {tx('清空的是词条、例句、翻译缓存、待翻译队列与本地诊断日志；设置与词库不变。')}
          </div>

          {/* FR-L5：体积自检。占用来自 `navigator.storage.estimate()` 的真实查询；
              拿不到时显示"未知"而不是"正常"（不知道 ≠ 健康） */}
          <div style={{ marginTop: 14 }} aria-label={tx('体积自检')}>
            <div>
              {tx('占用 {size}', { size: formatBytes(storage.usage) })}
              {storage.quota !== null && ` ${tx('/ 配额 {size}', { size: formatBytes(storage.quota) })}`}{tx('；词 ')}
              {tx('{words} 条 / 例句 {scenes} 条', { words: health ? health.words : '…', scenes: health ? health.scenes : '…' })}
              {health?.persistGranted ? tx('（已受持久化保护）') : ''}
            </div>
            <div className="hint">
              {tx('上次导出：')}
              {health?.lastExportAt
                ? new Date(health.lastExportAt).toLocaleString()
                : tx('从未导出')}
            </div>            {/* FR-E6：卸载风险必须常驻明说——此前只在"占用告警"分支里提过一句，
                正常用户看不到它 */}
            <div className="hint">
              {tx('卸载本扩展或清理浏览器数据，会连同本地生词与例句一起清除；扩展不保留云端副本，删除后无法恢复。建议定期导出 JSON 备份。')}
            </div>
            {storage.level === 'warn' && (
              <div className="field-error">
                {tx('占用已超过阈值（{reason}），', { reason: storage.reason === 'ratio' ? tx('接近浏览器给的配额') : tx('数据量较大') })}
                {tx('建议先导出一次备份：数据只在本机，卸载或清理浏览器数据都会丢掉。')}
              </div>
            )}
            {storage.level === 'unknown' && (
              <div className="hint">{tx('浏览器没有提供配额信息，因此占用大小未知（不代表数据小）。')}</div>
            )}
          </div>

          {/* FR-G1：导出的两个范围（当前筛选结果 / 选中项）只有在列表页才说得清，
              因此入口放在「生词」页，这里只做指引 */}
          <div className="hint">
            {tx('导出（Anki TSV / 通用 CSV / 不背单词 / 墨墨背单词 / JSON 备份）在「生词」页的工具栏里。')}
          </div>

          {/* FR-J4 ~ J7：导入器（存量迁移与备份回灌） */}
          <ImportSection />

          {/* FR-B7：词库导入（用户自备 ecdict.csv） */}
          <DictionarySection deps={browserDictionaryDeps()} />

          {/* FR-D6 / FR-D7：翻译待办与首次开启告知 */}
          <TranslateStatus />

          {/* FR-H1：WebDAV 四项配置 */}
          <label htmlFor="s-webdav-url">{tx('WebDAV 服务器')}</label>
          <div>
            <input
              id="s-webdav-url"
              style={{ width: '100%' }}
              placeholder={tx('如 https://dav.jianguoyun.com/dav/')}
              value={form.webdav?.url ?? ''}
              onChange={(e) =>
                patch({
                  webdav: {
                    url: e.target.value,
                    username: form.webdav?.username ?? '',
                    password: form.webdav?.password ?? '',
                    path: form.webdav?.path ?? '',
                  },
                })
              }
            />
            <input
              style={{ width: '100%', marginTop: 6 }}
              placeholder={tx('用户名')}
              value={form.webdav?.username ?? ''}
              onChange={(e) =>
                patch({
                  webdav: {
                    url: form.webdav?.url ?? '',
                    username: e.target.value,
                    password: form.webdav?.password ?? '',
                    path: form.webdav?.path ?? '',
                  },
                })
              }
            />
            <input
              style={{ width: '100%', marginTop: 6 }}
              type="password"
              placeholder={tx('应用密码（不是登录密码）')}
              value={form.webdav?.password ?? ''}
              onChange={(e) =>
                patch({
                  webdav: {
                    url: form.webdav?.url ?? '',
                    username: form.webdav?.username ?? '',
                    password: e.target.value,
                    path: form.webdav?.path ?? '',
                  },
                })
              }
            />
            <input
              style={{ width: '100%', marginTop: 6 }}
              placeholder={tx('远端路径，如 /leximate/sync.json')}
              value={form.webdav?.path ?? ''}
              onChange={(e) =>
                patch({
                  webdav: {
                    url: form.webdav?.url ?? '',
                    username: form.webdav?.username ?? '',
                    password: form.webdav?.password ?? '',
                    path: e.target.value,
                  },
                })
              }
            />
            <input
              style={{ width: '100%', marginTop: 6 }}
              type="password"
              placeholder={tx('同步口令（可选，填了就加密远端）')}
              value={form.webdav?.passphrase ?? ''}
              onChange={(e) =>
                patch({
                  webdav: {
                    url: form.webdav?.url ?? '',
                    username: form.webdav?.username ?? '',
                    password: form.webdav?.password ?? '',
                    path: form.webdav?.path ?? '',
                    passphrase: e.target.value,
                  },
                })
              }
            />
            {errors.webdav && <div className="field-error">{errors.webdav}</div>}
            {(form.webdav?.passphrase ?? '').trim() === '' && (
              // FR-H5：关闭加密时必须看到明文风险，而且要说清是什么风险
              <div className="danger" role="status">
                {tx('未填同步口令：远端文件是明文，任何能访问这个 WebDAV 的人都能读到你的生词与例句。口令只存在本机，忘掉就无法解密已上传的内容。')}
              </div>
            )}
            <div className="hint">
              {tx('凭据只存在本机，不进导出文件、也不随同步文件上传。坚果云需在「安全选项」里生成应用密码。')}
            </div>
          </div>

          {/* FR-H6：同步状态与手动重试 */}
          <SyncStatus />
        </div>

        <h3 style={{ fontSize: '.85rem', color: 'var(--muted)', marginTop: 22 }}>{tx('尚未启用的设置')}</h3>
        <p className="hint">
          {tx('WebDAV 同步（M3）、词库管理（M1-9）尚未实现，因此这里不提供入口，也不放不可用的假开关。')}
        </p>
        <p className="hint">
          {tx('触发方式（划词 / 点击单词 / 两者都要）：目前只提供「划词」触发（FR-A1）。按 decisions/0026 的澄清，「点击单词查词」就是划词查词，不构成独立能力；字段留在数据模型里，界面不提供切换入口。')}
        </p>
        <p className="hint">
          {tx('主题 / 每页条数：这两个字段没有消费者——主题不在 FR 表里，列表是虚拟滚动、不分页，所以「每页条数」没有意义。因此不提供入口；要启用先让它们真的被读。界面语言已经有消费者（App.tsx 经 utils/i18n 取文案），入口就在上方。')}
        </p>
        <p className="hint">
          {tx('划词的入库口径：默认不自动入库（见上方「选中即入库」）——划词只弹卡片，点「加入生词本」才收藏；且只有完整覆盖整个词的选区才会弹卡片（在 proof 里只拖到 proo 不算选中一个词）。遇见次数只在已收藏的词被再次划到时 +1，因此误选不会污染生词本。')}
        </p>
        <p className="hint">
          {tx('状态说明：{statuses}。被「忽略」的词不再采集例句（PLAN.md OQ14）。', {
            statuses: STATUS_ORDER.map(statusLabel).join(' / '),
          })}
        </p>
      </section>
    </>
  );
}
