import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('entrypoints/content.ts', 'utf8');

describe('FR-A14：内容脚本设置热更新接线', () => {
  it('初始 OFF 或黑名单跳过前就必须注册消息监听', () => {
    expect(source.indexOf('browser.runtime.onMessage.addListener')).toBeGreaterThan(-1);
    expect(source.indexOf('browser.runtime.onMessage.addListener')).toBeLessThan(
      source.indexOf('await controller.start()'),
    );
  });

  it('初始跳过不能在注册监听前 return', () => {
    expect(source).not.toContain('if (!started) return;');
  });

  it('收到新设置后必须更新控制器快照，不能只改语速和启停', () => {
    expect(source).toContain('controller.updateSettings(next)');
  });
});
