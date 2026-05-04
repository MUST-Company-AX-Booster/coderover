import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ValueTransformer } from 'typeorm';

/**
 * AES-256-GCM TypeORM ValueTransformer for protecting token columns at rest.
 *
 * Use it on any `text`/`varchar` column that holds a secret (OAuth access
 * token, refresh token, GitHub PAT, etc):
 *
 * @example
 *   import { encryptedString } from '../common/crypto/encrypted-string.transformer';
 *
 *   @Column({ name: 'access_token', type: 'text', transformer: encryptedString })
 *   accessToken!: string;
 *
 * Stored format:
 *   `enc.v1.<iv-base64>.<ciphertext-base64>.<authtag-base64>`
 *
 * Why a string envelope and not the JSON envelope used by `CryptoService`:
 *   `CryptoService` was designed for `SystemSetting.value` (jsonb). Token
 *   columns are plain `text`, so we serialise the same primitives into a
 *   single dot-separated string instead of changing the column type. Both
 *   transformers read the SAME master key (`SETTINGS_ENCRYPTION_KEY`) so
 *   key rotation is one operation, not two.
 *
 * Lazy-migrate behaviour:
 *   If a stored value lacks the `enc.v1.` prefix it is returned as-is on
 *   read. This lets us deploy the transformer without a forced rewrite of
 *   every existing row — old plaintext tokens stay readable, and the very
 *   next save (token refresh, reconnect, etc) writes them back encrypted.
 *
 * Failure modes:
 *   - `SETTINGS_ENCRYPTION_KEY` unset       → throws on first encrypt/decrypt
 *   - key wrong length / bad base64         → throws on first encrypt/decrypt
 *   - tampered ciphertext / wrong key       → throws (GCM auth-tag check)
 *   All three are intentional fail-closed paths — better to 500 a request
 *   than to silently leak or accept poisoned tokens.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // 256 bits
const IV_BYTES = 12; // 96 bits — recommended for GCM
const VERSION_PREFIX = 'enc.v1.';
const KEY_ENV = 'SETTINGS_ENCRYPTION_KEY';

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyB64 = process.env[KEY_ENV];
  if (!keyB64) {
    throw new Error(
      `${KEY_ENV} is not set — cannot encrypt/decrypt token columns. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(keyB64, 'base64');
  } catch (err) {
    throw new Error(`${KEY_ENV} must be valid base64 (${(err as Error).message})`);
  }
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${KEY_ENV} must decode to ${KEY_BYTES} bytes; got ${decoded.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  cachedKey = decoded;
  return cachedKey;
}

/**
 * Test-only: clear the cached key so unit tests can swap `process.env`
 * between cases without restarting the worker.
 */
export function __resetEncryptionKeyCacheForTests(): void {
  cachedKey = null;
}

/** Encrypt a UTF-8 string into the versioned envelope format. */
export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    VERSION_PREFIX +
    iv.toString('base64') +
    '.' +
    ct.toString('base64') +
    '.' +
    tag.toString('base64')
  );
}

/**
 * Decrypt a versioned envelope back to plaintext. If the input does NOT
 * start with the version prefix, it is returned as-is — that's the
 * legacy-plaintext lazy-migrate path. Throws on malformed envelope or
 * GCM auth-tag mismatch.
 */
export function decryptString(stored: string): string {
  if (!stored.startsWith(VERSION_PREFIX)) return stored;
  const parts = stored.slice(VERSION_PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Encrypted token is malformed (expected enc.v1.<iv>.<ct>.<tag>, got ${parts.length} segments)`,
    );
  }
  const [ivB64, ctB64, tagB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error(`Invalid IV length in encrypted token: ${iv.length}`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const encryptedString: ValueTransformer = {
  to(plaintext: unknown): string | null | undefined {
    if (plaintext === null) return null;
    if (plaintext === undefined) return undefined;
    if (typeof plaintext !== 'string') {
      throw new Error(
        `encryptedString transformer expects string|null|undefined, got ${typeof plaintext}`,
      );
    }
    if (plaintext === '') return '';
    return encryptString(plaintext);
  },
  from(stored: unknown): string | null | undefined {
    if (stored === null) return null;
    if (stored === undefined) return undefined;
    if (typeof stored !== 'string') {
      throw new Error(
        `encryptedString transformer expects string|null|undefined, got ${typeof stored}`,
      );
    }
    if (stored === '') return '';
    return decryptString(stored);
  },
};
