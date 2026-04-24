import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Envelope format stored in SystemSetting.value for secret rows.
 *
 * Versioned to allow future key rotation schemes (v2 could add a keyId field
 * pointing at a KMS, for example). Ciphertext, iv, and tag are base64-encoded
 * because SystemSetting.value is jsonb.
 */
export interface EncryptedEnvelope {
  encrypted: true;
  v: 1;
  ciphertext: string;
  iv: string;
  tag: string;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // 256 bits
const IV_BYTES = 12; // recommended for GCM
const TAG_BYTES = 16; // GCM auth tag

/**
 * AES-256-GCM wrapper for protecting SystemSetting secrets at rest.
 *
 * Reads a base64 32-byte master key from env `SETTINGS_ENCRYPTION_KEY`. The
 * key MUST stay in env — chicken-and-egg: we need it to decrypt DB secrets.
 * Fails fast on module init if the key is missing or malformed so production
 * deploys don't silently boot into a state where secret rows are unreadable.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer | null = null;

  /**
   * Load and validate the master key eagerly in the constructor, NOT in
   * `onModuleInit`. NestJS guarantees dependent providers are instantiated
   * before their consumer, but `onModuleInit` fires AFTER the consumer's
   * `onModuleInit` may have already started — so if we defer key loading
   * to the init hook, AdminConfigService's legacy-migration pass runs
   * first and sees a null key. Constructor-time load fixes this.
   */
  constructor(configService: ConfigService) {
    const keyB64 = configService.get<string>('SETTINGS_ENCRYPTION_KEY');
    if (!keyB64) {
      // Permit startup without the key in dev / CI where no secret rows are
      // touched. Any encrypt/decrypt call will throw with a clear error.
      this.logger.warn(
        'SETTINGS_ENCRYPTION_KEY is not set — CryptoService will throw if encrypt/decrypt is called. Set it in production.',
      );
      return;
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(keyB64, 'base64');
    } catch (err) {
      throw new InternalServerErrorException(
        `SETTINGS_ENCRYPTION_KEY must be valid base64 (${(err as Error).message})`,
      );
    }
    if (decoded.length !== KEY_BYTES) {
      throw new InternalServerErrorException(
        `SETTINGS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${decoded.length}. Generate one with: openssl rand -base64 32`,
      );
    }
    this.key = decoded;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new InternalServerErrorException(
        'SETTINGS_ENCRYPTION_KEY is not configured — cannot encrypt/decrypt secrets. Set the env var and restart.',
      );
    }
    return this.key;
  }

  /** Encrypt a plaintext string into an opaque envelope. */
  encrypt(plaintext: string): EncryptedEnvelope {
    const key = this.requireKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: true,
      v: 1,
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  /** Decrypt an envelope back to plaintext. Throws on tag mismatch (tamper). */
  decrypt(envelope: EncryptedEnvelope): string {
    const key = this.requireKey();
    if (envelope.v !== 1) {
      throw new InternalServerErrorException(
        `Unsupported EncryptedEnvelope version: ${envelope.v}`,
      );
    }
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (iv.length !== IV_BYTES) {
      throw new InternalServerErrorException(`Invalid IV length: ${iv.length}`);
    }
    if (tag.length !== TAG_BYTES) {
      throw new InternalServerErrorException(`Invalid auth tag length: ${tag.length}`);
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /** Type guard — cheap structural check for DB reads. */
  isEnvelope(value: unknown): value is EncryptedEnvelope {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
      v.encrypted === true &&
      v.v === 1 &&
      typeof v.ciphertext === 'string' &&
      typeof v.iv === 'string' &&
      typeof v.tag === 'string'
    );
  }
}
