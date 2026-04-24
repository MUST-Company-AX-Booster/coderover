import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { CryptoService, EncryptedEnvelope } from './crypto.service';

/**
 * Unit tests for CryptoService — round trip, tamper detection, wrong-key
 * decrypt failure, envelope detection. No NestJS test harness needed; the
 * service reads the key synchronously from a ConfigService stub.
 */
describe('CryptoService', () => {
  const keyB64 = crypto.randomBytes(32).toString('base64');

  const UNSET = Symbol('UNSET');
  type KeyOverride = string | typeof UNSET;

  // Sentinel avoids the `?? keyB64` pitfall when an explicit undefined is
  // passed: we want to distinguish "use default" from "simulate unset".
  function makeService(keyOverride: KeyOverride = keyB64) {
    const configGet = jest.fn((k: string) => {
      if (k === 'SETTINGS_ENCRYPTION_KEY') {
        return keyOverride === UNSET ? undefined : keyOverride;
      }
      return undefined;
    });
    const config = { get: configGet } as unknown as ConfigService;
    return new CryptoService(config);
  }

  it('round-trips a plaintext string', () => {
    const svc = makeService();
    const env = svc.encrypt('sk-or-v1-abc123');
    expect(env.encrypted).toBe(true);
    expect(env.v).toBe(1);
    expect(svc.decrypt(env)).toBe('sk-or-v1-abc123');
  });

  it('produces distinct ciphertext for same plaintext (random IV)', () => {
    const svc = makeService();
    const a = svc.encrypt('same-secret');
    const b = svc.encrypt('same-secret');
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.iv).not.toEqual(b.iv);
  });

  it('detects tampering via the GCM auth tag', () => {
    const svc = makeService();
    const env = svc.encrypt('don-not-touch');
    const tampered: EncryptedEnvelope = {
      ...env,
      ciphertext: Buffer.from('totally-different').toString('base64'),
    };
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('fails decryption with a different key', () => {
    const svcA = makeService(crypto.randomBytes(32).toString('base64'));
    const svcB = makeService(crypto.randomBytes(32).toString('base64'));
    const env = svcA.encrypt('secret');
    expect(() => svcB.decrypt(env)).toThrow();
  });

  it('throws a clear error when no key is configured and encrypt is called', () => {
    const svc = makeService(UNSET);
    expect(() => svc.encrypt('anything')).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => makeService(Buffer.from('too-short').toString('base64'))).toThrow(
      /must decode to 32 bytes/,
    );
  });

  it('isEnvelope correctly classifies values', () => {
    const svc = makeService();
    const env = svc.encrypt('x');
    expect(svc.isEnvelope(env)).toBe(true);
    expect(svc.isEnvelope('plaintext')).toBe(false);
    expect(svc.isEnvelope(null)).toBe(false);
    expect(svc.isEnvelope({})).toBe(false);
    expect(svc.isEnvelope({ encrypted: true, v: 99, ciphertext: 'x', iv: 'x', tag: 'x' })).toBe(
      false,
    );
    expect(svc.isEnvelope({ encrypted: true, v: 1, ciphertext: 'x', iv: 'x' })).toBe(false);
  });

  it('rejects an envelope with unsupported version', () => {
    const svc = makeService();
    const env = svc.encrypt('x');
    const bad = { ...env, v: 2 as unknown as 1 };
    expect(() => svc.decrypt(bad as EncryptedEnvelope)).toThrow(/Unsupported/);
  });
});
