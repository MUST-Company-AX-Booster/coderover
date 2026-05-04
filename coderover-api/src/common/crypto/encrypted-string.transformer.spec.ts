import * as crypto from 'crypto';
import {
  __resetEncryptionKeyCacheForTests,
  decryptString,
  encryptString,
  encryptedString,
} from './encrypted-string.transformer';

/**
 * Unit tests for the AES-256-GCM token-at-rest transformer.
 *
 * Covers: round-trip, distinct ciphertext per call (random IV), tamper
 * detection via auth tag, wrong-key rejection, missing/short key,
 * legacy-plaintext lazy-migrate, and the ValueTransformer null/empty edge
 * cases that TypeORM is allowed to feed us.
 */
describe('encryptedString transformer', () => {
  const KEY = crypto.randomBytes(32).toString('base64');
  const ORIGINAL_KEY_ENV = process.env.SETTINGS_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = KEY;
    __resetEncryptionKeyCacheForTests();
  });

  afterAll(() => {
    if (ORIGINAL_KEY_ENV === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
    }
    __resetEncryptionKeyCacheForTests();
  });

  it('round-trips a typical OAuth access token', () => {
    const plaintext = 'gho_abcdef1234567890_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const stored = encryptString(plaintext);
    expect(stored).toMatch(/^enc\.v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(decryptString(stored)).toBe(plaintext);
  });

  it('round-trips a multi-byte UTF-8 plaintext (just in case scope strings ever land here)', () => {
    const plaintext = 'scope:read repo, owner=测试-müller-🔐';
    expect(decryptString(encryptString(plaintext))).toBe(plaintext);
  });

  it('produces distinct ciphertext for the same plaintext (random IV)', () => {
    const a = encryptString('same-token');
    const b = encryptString('same-token');
    expect(a).not.toBe(b);
    // Format is `enc.v1.<iv>.<ct>.<tag>` so the IV is segment [2].
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });

  it('rejects tampered ciphertext via the GCM auth tag', () => {
    const stored = encryptString('don-not-touch');
    const parts = stored.split('.');
    const ctBuf = Buffer.from(parts[2], 'base64');
    ctBuf[0] ^= 0x01; // flip one bit
    parts[2] = ctBuf.toString('base64');
    const tampered = parts.join('.');
    expect(() => decryptString(tampered)).toThrow();
  });

  it('rejects a value encrypted under a different key', () => {
    const stored = encryptString('rotated-out');
    process.env.SETTINGS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    __resetEncryptionKeyCacheForTests();
    expect(() => decryptString(stored)).toThrow();
  });

  it('returns legacy plaintext as-is (lazy-migrate)', () => {
    expect(decryptString('gho_legacy_plaintext_token')).toBe('gho_legacy_plaintext_token');
    expect(decryptString('ghp_personal_access_token_abc')).toBe('ghp_personal_access_token_abc');
  });

  it('throws a clear error when SETTINGS_ENCRYPTION_KEY is unset', () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    __resetEncryptionKeyCacheForTests();
    expect(() => encryptString('x')).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('rejects a key of the wrong length', () => {
    process.env.SETTINGS_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    __resetEncryptionKeyCacheForTests();
    expect(() => encryptString('x')).toThrow(/must decode to 32 bytes/);
  });

  it('rejects a malformed envelope (wrong segment count)', () => {
    expect(() => decryptString('enc.v1.only-two-segments')).toThrow(/malformed/);
    expect(() => decryptString('enc.v1.a.b.c.d.e')).toThrow(/malformed/);
  });

  describe('ValueTransformer.to', () => {
    it('passes through null and undefined unchanged', () => {
      expect(encryptedString.to(null)).toBeNull();
      expect(encryptedString.to(undefined)).toBeUndefined();
    });

    it('passes through empty string unchanged (no encryption needed)', () => {
      expect(encryptedString.to('')).toBe('');
    });

    it('encrypts a non-empty string into the versioned envelope', () => {
      const out = encryptedString.to('ghp_test') as string;
      expect(out).toMatch(/^enc\.v1\./);
    });

    it('throws for non-string non-null input (defensive guard)', () => {
      expect(() => encryptedString.to(42 as unknown)).toThrow();
      expect(() => encryptedString.to({} as unknown)).toThrow();
    });
  });

  describe('ValueTransformer.from', () => {
    it('passes through null and undefined unchanged', () => {
      expect(encryptedString.from(null)).toBeNull();
      expect(encryptedString.from(undefined)).toBeUndefined();
    });

    it('passes through empty string unchanged', () => {
      expect(encryptedString.from('')).toBe('');
    });

    it('decrypts a previously-encrypted value back to plaintext', () => {
      const stored = encryptedString.to('ghp_round_trip') as string;
      expect(encryptedString.from(stored)).toBe('ghp_round_trip');
    });

    it('returns legacy plaintext (no enc.v1. prefix) as-is', () => {
      expect(encryptedString.from('legacy-plaintext')).toBe('legacy-plaintext');
    });

    it('throws for non-string non-null input', () => {
      expect(() => encryptedString.from(42 as unknown)).toThrow();
    });
  });
});
