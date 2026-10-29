/**
 * 可选口令加密（PLAN.md FR-H5）。
 *
 * 目标只有一个：**开启之后，远端文件是密文**。因此这里不追求花哨的协议，
 * 只用浏览器内建的 WebCrypto：PBKDF2 派生密钥 + AES-GCM 加密。
 *
 * 几个刻意的选择：
 *  - **GCM 而不是 CBC**：它自带完整性校验。口令错了必须**明确报错**，
 *    而不是解出一堆乱码写进库（那是数据损坏）。
 *  - **salt 与 iv 存进载荷**（它们不是秘密），口令本身**永不存储**。
 *  - 迭代次数固定写死并随载荷带版本号：换参数时靠 `kdf` 字段识别，而不是猜。
 */
const KDF_NAME = 'PBKDF2-SHA256';
const ITERATIONS = 210_000; // OWASP 2023 对 PBKDF2-SHA256 的建议量级
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedPayload {
  kind: 'leximate-sync-encrypted';
  schemaVersion: number;
  /** 加密参数，解密方据此复现密钥 */
  kdf: { name: typeof KDF_NAME; iterations: number; salt: string };
  /** base64 的 iv 与密文 */
  iv: string;
  data: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** 加密。返回可直接 JSON.stringify 的对象 */
export async function encryptPayload(
  plaintext: string,
  password: string,
  options: { schemaVersion: number; salt?: Uint8Array; iv?: Uint8Array },
): Promise<EncryptedPayload> {
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, ITERATIONS, 'encrypt');
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    kind: 'leximate-sync-encrypted',
    schemaVersion: options.schemaVersion,
    kdf: { name: KDF_NAME, iterations: ITERATIONS, salt: toBase64(salt) },
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  };
}

export type DecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: 'not-encrypted' | 'kdf' | 'shape' | 'wrong-password' };

/**
 * 解密。**口令不对必须返回 `wrong-password`**（AES-GCM 的校验失败就是它），
 * 不能把乱码当成功——那会把整库写坏。
 */
export async function decryptPayload(raw: string, password: string): Promise<DecryptResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'shape' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'shape' };

  const record = parsed as Record<string, unknown>;
  if (record.kind !== 'leximate-sync-encrypted') return { ok: false, reason: 'not-encrypted' };

  const kdf = record.kdf as { name?: unknown; iterations?: unknown; salt?: unknown } | undefined;
  if (!kdf || kdf.name !== KDF_NAME || typeof kdf.iterations !== 'number' || typeof kdf.salt !== 'string') {
    return { ok: false, reason: 'kdf' };
  }
  if (typeof record.iv !== 'string' || typeof record.data !== 'string') return { ok: false, reason: 'shape' };

  try {
    const key = await deriveKey(password, fromBase64(kdf.salt), kdf.iterations, 'decrypt');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) as unknown as BufferSource },
      key,
      fromBase64(record.data) as unknown as BufferSource,
    );
    return { ok: true, plaintext: new TextDecoder().decode(plain) };
  } catch {
    // GCM 校验失败 = 口令不对或密文被改过，两者对用户是同一件事
    return { ok: false, reason: 'wrong-password' };
  }
}

/** 远端内容是不是密文（决定要不要口令） */
export function isEncryptedPayload(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return parsed?.kind === 'leximate-sync-encrypted';
  } catch {
    return false;
  }
}
