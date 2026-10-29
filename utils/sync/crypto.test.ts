/**
 * 口令加密（PLAN.md FR-H5）。
 *
 * 最要紧的一条：**口令错了必须明确失败**，不能解出乱码当成功——
 * 那会把整库写坏，而用户只会看到"词全乱了"。
 */
import { describe, expect, it } from 'vitest';
import { decryptPayload, encryptPayload, isEncryptedPayload } from './crypto';

const plaintext = JSON.stringify({ kind: 'leximate-sync', schemaVersion: 1, words: [], scenes: [] });

describe('往返', () => {
  it('加密后能原样解回来', async () => {
    const encrypted = await encryptPayload(plaintext, 'correct horse', { schemaVersion: 1 });
    const result = await decryptPayload(JSON.stringify(encrypted), 'correct horse');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plaintext).toBe(plaintext);
  });

  it('密文里看不到明文内容（远端确实是密文）', async () => {
    const encrypted = await encryptPayload('秘密句子 secret-sentence', 'pw', { schemaVersion: 1 });
    const serialized = JSON.stringify(encrypted);

    expect(serialized).not.toContain('secret-sentence');
    expect(serialized).not.toContain('秘密');
  });

  it('载荷形状带版本与 kdf 参数（换参数时靠它识别，不靠猜）', async () => {
    const encrypted = await encryptPayload(plaintext, 'pw', { schemaVersion: 3 });

    expect(encrypted.kind).toBe('leximate-sync-encrypted');
    expect(encrypted.schemaVersion).toBe(3);
    expect(encrypted.kdf.name).toBe('PBKDF2-SHA256');
    expect(encrypted.kdf.iterations).toBeGreaterThan(100_000);
    expect(encrypted.kdf.salt).not.toBe('');
  });

  it('同样的明文+口令，两次加密结果不同（iv/salt 随机）', async () => {
    const a = await encryptPayload(plaintext, 'pw', { schemaVersion: 1 });
    const b = await encryptPayload(plaintext, 'pw', { schemaVersion: 1 });

    expect(a.data).not.toBe(b.data);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
  });
});

describe('失败要明确', () => {
  it('口令不对 → wrong-password（不是乱码）', async () => {
    const encrypted = await encryptPayload(plaintext, 'right', { schemaVersion: 1 });
    const result = await decryptPayload(JSON.stringify(encrypted), 'wrong');

    expect(result).toEqual({ ok: false, reason: 'wrong-password' });
  });

  it('密文被改过 → wrong-password（GCM 的完整性校验起作用）', async () => {
    const encrypted = await encryptPayload(plaintext, 'pw', { schemaVersion: 1 });
    const tampered = { ...encrypted, data: `${encrypted.data.slice(0, -4)}AAAA` };
    const result = await decryptPayload(JSON.stringify(tampered), 'pw');

    expect(result).toEqual({ ok: false, reason: 'wrong-password' });
  });

  it('不是加密载荷 → not-encrypted', async () => {
    expect(await decryptPayload(plaintext, 'pw')).toEqual({ ok: false, reason: 'not-encrypted' });
  });

  it('kdf 不认识 → kdf（不猜参数）', async () => {
    const bad = JSON.stringify({ kind: 'leximate-sync-encrypted', kdf: { name: 'md5' }, iv: 'a', data: 'b' });
    expect(await decryptPayload(bad, 'pw')).toEqual({ ok: false, reason: 'kdf' });
  });

  it('形状不对 → shape', async () => {
    expect(await decryptPayload('{oops', 'pw')).toEqual({ ok: false, reason: 'shape' });
    expect(await decryptPayload(JSON.stringify({ kind: 'leximate-sync-encrypted' }), 'pw')).toEqual({
      ok: false,
      reason: 'kdf',
    });
  });
});

describe('isEncryptedPayload', () => {
  it('认得出密文与明文', async () => {
    const encrypted = await encryptPayload(plaintext, 'pw', { schemaVersion: 1 });
    expect(isEncryptedPayload(JSON.stringify(encrypted))).toBe(true);
    expect(isEncryptedPayload(plaintext)).toBe(false);
    expect(isEncryptedPayload('not json')).toBe(false);
  });
});
