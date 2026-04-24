import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import OpenAI from 'openai';
import { Repository } from 'typeorm';
import { SettingAudit } from '../entities/setting-audit.entity';
import { SystemSetting } from '../entities/system-setting.entity';
import { TestLlmConfigDto, UpdateLlmConfigDto } from './dto/update-setting.dto';
import {
  createLocalChatCompletion,
  getLlmCredentialError,
  normalizeLlmApiKey,
  resolveLlmBaseUrl,
  resolveLlmProvider,
} from '../config/openai.config';
import { CryptoService, EncryptedEnvelope } from '../common/crypto/crypto.service';

type SettingValue = string | number | boolean | Record<string, unknown>;

export interface SettingAuditRecord {
  id: string;
  key: string;
  previousValue: SettingValue | null;
  nextValue: SettingValue | string;
  version: number;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Keys that hold secrets. `updateSetting` auto-encrypts these via
 * CryptoService before persisting, and `listSettings` redacts the value
 * from API responses.
 */
const SECRET_KEYS = new Set<string>([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
]);

/**
 * All keys that can be managed from the Settings UI. Anything not in this
 * list is rejected by `updateSetting`. `getSettingString` returns DB value
 * if present, else falls through to `ConfigService.get(key)` (the env) so
 * first-boot / CI environments keep working.
 *
 * Infra keys (DATABASE_*, REDIS_*, JWT_SECRET, SETTINGS_ENCRYPTION_KEY)
 * deliberately stay env-only — we need them before the DB is reachable.
 */
const MANAGED_KEYS = [
  // LLM config
  'LLM_PROVIDER',
  'OPENAI_BASE_URL',
  'OPENAI_CHAT_MODEL',
  'OPENAI_EMBEDDING_MODEL',
  'OPENAI_EMBEDDING_DIMENSIONS',
  'LLM_HEALTH_CHECK_ENABLED',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  // GitHub integration
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  // App
  'FRONTEND_APP_URL',
  'PUBLIC_API_BASE_URL',
  // Feature flags + cadence
  'FILE_WATCH_ENABLED',
  'AGENT_PR_ENABLED',
  'AGENT_SCAN_ON_PUSH',
  'AGENT_HEALTH_CRON',
  'AGENT_MAX_RUNS_PER_HOUR',
] as const;

type ManagedKey = (typeof MANAGED_KEYS)[number];

const CACHE_TTL_MS = 30_000;

@Injectable()
export class AdminConfigService implements OnModuleInit {
  private readonly logger = new Logger(AdminConfigService.name);

  /**
   * 30-second in-memory cache for `getSettingString` — prevents hot paths
   * (e.g. every chat request reading OPENAI_API_KEY + OPENAI_BASE_URL) from
   * hammering the DB. Invalidated on `updateSetting`.
   */
  private cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(SystemSetting)
    private readonly settingRepository: Repository<SystemSetting>,
    @InjectRepository(SettingAudit)
    private readonly auditRepository: Repository<SettingAudit>,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit() {
    await this.bootstrapManagedSettings();
    await this.migrateLegacyPlaintextSecrets();
  }

  async listSettings() {
    const rows = await this.settingRepository.find({
      where: MANAGED_KEYS.map((key) => ({ key })),
      order: { key: 'ASC' },
    });
    return rows.map((item) => {
      const hasValue = this.hasStoredValue(item);
      return {
        key: item.key,
        value: item.isSecret ? null : item.value,
        isSecret: item.isSecret,
        isSet: item.isSecret ? hasValue : true,
        encrypted: item.encrypted,
        version: item.version,
        updatedAt: item.updatedAt.toISOString(),
      };
    });
  }

  async listAudit(limit = 100) {
    const rows = await this.auditRepository.find({
      take: Math.max(1, Math.min(limit, 500)),
      order: { createdAt: 'DESC' },
    });
    return rows.map((item) => ({
      id: item.id,
      key: item.settingKey,
      previousValue: item.previousValue,
      nextValue: this.isSecretKey(item.settingKey) ? '[REDACTED]' : item.nextValue,
      version: item.version,
      reason: item.reason,
      updatedBy: item.updatedBy,
      updatedAt: item.createdAt.toISOString(),
    }));
  }

  async updateSetting(
    key: string,
    value: SettingValue,
    updatedBy: string,
    reason?: string,
    expectedVersion?: number,
  ) {
    if (!MANAGED_KEYS.includes(key as ManagedKey)) {
      throw new BadRequestException(`Unsupported setting key: ${key}`);
    }

    const current = await this.settingRepository.findOne({ where: { key } });
    if (typeof expectedVersion === 'number' && current && current.version !== expectedVersion) {
      throw new BadRequestException(`Version mismatch for ${key}`);
    }

    const isSecret = this.isSecretKey(key);
    const nextVersion = (current?.version ?? 0) + 1;

    // Secrets go through the AES-GCM envelope before persistence. Non-secret
    // values are stored as-is so the Settings UI can still render them.
    const storedValue: SettingValue | EncryptedEnvelope =
      isSecret && value !== null && value !== undefined
        ? this.crypto.encrypt(String(value))
        : value;
    const encryptedFlag = isSecret && value !== null && value !== undefined;

    const record = this.settingRepository.create({
      key,
      value: storedValue as SettingValue,
      isSecret,
      encrypted: encryptedFlag,
      version: nextVersion,
      updatedBy,
    });
    await this.settingRepository.save(record);

    const audit = this.auditRepository.create({
      settingKey: key,
      // Never write secret plaintext to the audit log — neither old nor new.
      previousValue: current?.isSecret ? null : current?.value ?? null,
      nextValue: isSecret ? null : value,
      version: nextVersion,
      reason: reason || 'No reason provided',
      updatedBy,
    });
    await this.auditRepository.save(audit);

    // Invalidate cache so the next `getSettingString(key)` re-reads.
    this.cache.delete(key);

    return {
      key: record.key,
      value: record.isSecret ? null : record.value,
      isSecret: record.isSecret,
      isSet: record.isSecret ? true : undefined,
      encrypted: record.encrypted,
      version: record.version,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getLlmConfig() {
    const provider = await this.getSettingString('LLM_PROVIDER');
    const baseUrl = await this.getSettingString('OPENAI_BASE_URL');
    const chatModel = await this.getSettingString('OPENAI_CHAT_MODEL');
    const embeddingModel = await this.getSettingString('OPENAI_EMBEDDING_MODEL');
    const embeddingDimensions = Number((await this.getSettingString('OPENAI_EMBEDDING_DIMENSIONS')) || '1536');
    const openaiApiKeySet = Boolean(await this.getSettingString('OPENAI_API_KEY'));

    return {
      provider,
      baseUrl,
      chatModel,
      embeddingModel,
      embeddingDimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : 1536,
      openaiApiKeySet,
    };
  }

  async updateLlmConfig(dto: UpdateLlmConfigDto, updatedBy: string) {
    const updates: Array<{ key: string; value: SettingValue }> = [];

    if (dto.provider) updates.push({ key: 'LLM_PROVIDER', value: dto.provider });
    if (dto.baseUrl !== undefined) updates.push({ key: 'OPENAI_BASE_URL', value: dto.baseUrl });
    if (dto.chatModel) updates.push({ key: 'OPENAI_CHAT_MODEL', value: dto.chatModel });
    if (dto.embeddingModel) updates.push({ key: 'OPENAI_EMBEDDING_MODEL', value: dto.embeddingModel });
    if (typeof dto.embeddingDimensions === 'number') {
      updates.push({ key: 'OPENAI_EMBEDDING_DIMENSIONS', value: dto.embeddingDimensions });
    }
    if (dto.apiKey) updates.push({ key: 'OPENAI_API_KEY', value: dto.apiKey });

    if (!dto.dryRun) {
      for (const update of updates) {
        await this.updateSetting(update.key, update.value, updatedBy, 'LLM configuration update');
      }
    }

    return {
      updated: updates.map((item) => item.key),
      dryRun: Boolean(dto.dryRun),
      config: await this.getLlmConfig(),
    };
  }

  async testLlmConfig(dto: TestLlmConfigDto) {
    const resolved = await this.getLlmConfig();
    const provider = dto.provider || resolved.provider || 'openai';
    const model = dto.model || resolved.chatModel || 'gpt-4o-mini';
    const apiKey = normalizeLlmApiKey(await this.getSettingString('OPENAI_API_KEY'));
    const effectiveProvider = resolveLlmProvider(provider, apiKey, resolved.baseUrl || undefined);
    const baseURL = resolveLlmBaseUrl(
      effectiveProvider,
      resolved.baseUrl || undefined,
      apiKey,
      'generic',
    );
    const credentialError = getLlmCredentialError(effectiveProvider, apiKey);

    if (credentialError) {
      return {
        ok: false,
        provider,
        model,
        error: credentialError,
      };
    }

    const startedAt = Date.now();
    try {
      const openai = new OpenAI({ apiKey, baseURL });
      await Promise.race([
        effectiveProvider === 'local'
          ? createLocalChatCompletion({
              apiKey,
              baseUrl: resolved.baseUrl || undefined,
              model,
              messages: [{ role: 'user', content: dto.prompt || 'health check' }],
              temperature: 0,
              maxTokens: 32,
            })
          : effectiveProvider === 'openrouter'
            ? openai.chat.completions.create({
                model,
                temperature: 0,
                messages: [{ role: 'user', content: dto.prompt || 'Respond with OK' }],
              })
            : openai.models.list(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 3000ms')), 3000)),
      ]);
      return {
        ok: true,
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        prompt: dto.prompt || 'health check',
      };
    } catch (error) {
      return {
        ok: false,
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Back-compat alias; prefer `getSettingString` at call sites. */
  async getSecret(key: string): Promise<string> {
    return this.getSettingString(key);
  }

  async cleanupLegacyDefaultSettings(dryRun = false) {
    const keys = ['DEFAULT_REPO', 'DEFAULT_BRANCH'];
    const rows = await this.settingRepository.find({
      where: keys.map((key) => ({ key })),
      order: { key: 'ASC' },
    });

    if (!dryRun && rows.length > 0) {
      await this.settingRepository.remove(rows);
    }

    return {
      dryRun,
      removedKeys: rows.map((row) => row.key),
      removedCount: rows.length,
    };
  }

  /**
   * Seed rows for MANAGED_KEYS that aren't in the DB yet. Copies the env
   * value (if any) as the initial setting so behavior is unchanged after
   * bootstrap. Secret rows get encrypted on insertion.
   */
  private async bootstrapManagedSettings() {
    for (const key of MANAGED_KEYS) {
      const existing = await this.settingRepository.findOne({ where: { key } });
      if (existing) continue;

      const envValue = this.configService.get<string>(key);
      if (typeof envValue === 'undefined') {
        // AGENT_MAX_RUNS_PER_HOUR has a sensible default; others stay null.
        if (key !== 'AGENT_MAX_RUNS_PER_HOUR') continue;
      }

      const isSecret = this.isSecretKey(key);
      const defaultValue: SettingValue =
        typeof envValue === 'undefined' ? 3 : envValue;

      const storedValue: SettingValue | EncryptedEnvelope = isSecret
        ? this.crypto.encrypt(String(defaultValue))
        : defaultValue;

      await this.settingRepository.save(
        this.settingRepository.create({
          key,
          value: storedValue as SettingValue,
          isSecret,
          encrypted: isSecret,
          version: 1,
          updatedBy: 'system-bootstrap',
        }),
      );
    }
  }

  /**
   * One-time upgrade pass: detect any secret row whose `value` is still
   * plaintext (or any shape other than our EncryptedEnvelope) and re-save
   * through `crypto.encrypt`. Idempotent — already-wrapped rows are skipped
   * via `CryptoService.isEnvelope`.
   *
   * Safe to call every boot. Does nothing if SETTINGS_ENCRYPTION_KEY is
   * not configured (CryptoService throws clearly on encrypt).
   */
  private async migrateLegacyPlaintextSecrets(): Promise<void> {
    for (const key of SECRET_KEYS) {
      const row = await this.settingRepository.findOne({ where: { key } });
      if (!row) continue;
      if (row.value === null || row.value === undefined) continue;
      if (row.encrypted && this.crypto.isEnvelope(row.value)) continue;

      try {
        const plaintext = this.coerceToString(row.value);
        if (plaintext.length === 0) continue;
        const envelope = this.crypto.encrypt(plaintext);
        row.value = envelope as unknown as SettingValue;
        row.encrypted = true;
        await this.settingRepository.save(row);
        this.logger.log(`Encrypted legacy plaintext secret: ${key}`);
      } catch (err) {
        this.logger.warn(
          `Skipped legacy encryption for ${key}: ${err instanceof Error ? err.message : String(err)}. ` +
            `Set SETTINGS_ENCRYPTION_KEY and restart to complete migration.`,
        );
      }
    }
  }

  /**
   * DB-first lookup with env fallback. Public because call sites across the
   * backend (copilot, search, pr-review, embedder, auth, github-integration,
   * health, mcp) consume config through this method in Phase 4.
   *
   * Caches successful lookups for 30s; cache is invalidated on
   * `updateSetting` so UI changes propagate quickly.
   */
  async getSettingString(key: string): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const row = await this.settingRepository.findOne({ where: { key } });
    let value: string;

    if (row && this.hasStoredValue(row)) {
      value = this.unwrapValue(row);
    } else {
      value = this.configService.get<string>(key, '');
    }

    this.cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  private isSecretKey(key: string): boolean {
    return SECRET_KEYS.has(key);
  }

  /** True if the row's stored value is non-null/non-empty. */
  private hasStoredValue(row: SystemSetting): boolean {
    if (row.value === null || row.value === undefined) return false;
    if (row.encrypted && this.crypto.isEnvelope(row.value)) return true;
    if (typeof row.value === 'string') return row.value.length > 0;
    return true;
  }

  /** Decrypt if encrypted; otherwise coerce to string. */
  private unwrapValue(row: SystemSetting): string {
    if (row.encrypted && this.crypto.isEnvelope(row.value)) {
      return this.crypto.decrypt(row.value as EncryptedEnvelope);
    }
    return this.coerceToString(row.value);
  }

  private coerceToString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return '';
  }

  async getManagedSetting(key: string) {
    const row = await this.settingRepository.findOne({ where: { key } });
    if (!row) return null;
    return {
      key: row.key,
      value: row.isSecret ? null : row.value,
      isSecret: row.isSecret,
      encrypted: row.encrypted,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
