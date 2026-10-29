import type { Settings } from '../db/types';

/**
 * 内容脚本真正需要的设置。翻译与 WebDAV 凭据永远不得进入这个对象。
 *
 * 后台在消息边界再构造一次，入口在收到不可信消息时也构造一次，
 * 防止未来新增调用方绕过其中一层。
 */
export type ContentSettings = Pick<
  Settings,
  | 'enabled'
  | 'underlineStyle'
  | 'underlineColor'
  | 'underlineThickness'
  | 'reflectMeetCount'
  | 'blacklist'
  | 'trigger'
  | 'minWordLength'
  | 'autoAddOnSelect'
  | 'speechRate'
>;

const KEYS = [
  'enabled',
  'underlineStyle',
  'underlineColor',
  'underlineThickness',
  'reflectMeetCount',
  'blacklist',
  'trigger',
  'minWordLength',
  'autoAddOnSelect',
  'speechRate',
] as const satisfies readonly (keyof ContentSettings)[];

export function toContentSettings(input: unknown): ContentSettings {
  const source = typeof input === 'object' && input !== null
    ? input as Partial<ContentSettings>
    : {};
  const out: Partial<ContentSettings> = {};
  for (const key of KEYS) {
    const value = source[key];
    if (value !== undefined) {
      (out as Record<keyof ContentSettings, unknown>)[key] = value;
    }
  }
  return out as ContentSettings;
}
