import { describe, expect, it } from 'vitest';
import config from './wxt.config';

describe('FR-K1：HTTP 只进入可选主机权限', () => {
  it('本地 LLM 与 HTTP WebDAV 可获可选权限，安装时仍不申请主机权限', () => {
    const manifest = (config as typeof config & {
      manifest: {
        permissions?: string[];
        host_permissions?: string[];
        optional_host_permissions?: string[];
      };
    }).manifest;

    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(['https://*/*', 'http://*/*']),
    );
    expect(manifest.host_permissions ?? []).not.toContain('http://*/*');
    expect(manifest.host_permissions ?? []).not.toContain('https://*/*');
    expect(manifest.permissions ?? []).not.toContain('http://*/*');
    expect(manifest.permissions ?? []).not.toContain('https://*/*');
  });
});
