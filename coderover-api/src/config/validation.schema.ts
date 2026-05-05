import * as Joi from 'joi';

/**
 * Boot-time env validation.
 *
 * Keys that used to be `.required()` for LLM + GitHub config are now
 * `.optional()` because they moved to `SystemSetting` in the DB (see
 * `AdminConfigService.MANAGED_KEYS`). Call sites read DB-first with env
 * fallback via `AdminConfigService.getSettingString`, so the app still
 * boots if env is empty — the Settings UI is the source of truth at
 * runtime.
 *
 * Infra keys (DATABASE_*, REDIS_*, JWT_SECRET, SETTINGS_ENCRYPTION_KEY,
 * PORT, NODE_ENV) MUST stay env because we need them before the DB is
 * reachable / before secrets can be decrypted.
 */
export const validationSchema = Joi.object({
  PORT: Joi.number().default(3001),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  SWAGGER_USERNAME: Joi.string().optional().allow(''),
  SWAGGER_PASSWORD: Joi.string().optional().allow(''),

  DATABASE_HOST: Joi.string().required(),
  DATABASE_PORT: Joi.number().default(5434),
  DATABASE_NAME: Joi.string().required(),
  DATABASE_USER: Joi.string().required(),
  DATABASE_PASSWORD: Joi.string().required(),

  // Phase 5 (Zero Trust): dedicated migrate user. When set, boot-time
  // auto-migrate (and `npm run migration:run`) connect as this user
  // instead of DATABASE_USER. Lets DATABASE_USER stay on the
  // lower-privileged `coderover_app` role which cannot DDL. Both
  // optional: falling back to DATABASE_USER preserves pre-Phase-5
  // dev/CI behavior. Required-together when one is set.
  DATABASE_MIGRATE_USER: Joi.string().optional().allow(''),
  DATABASE_MIGRATE_PASSWORD: Joi.string()
    .optional()
    .allow('')
    .when('DATABASE_MIGRATE_USER', {
      is: Joi.string().required().min(1),
      then: Joi.string().required().min(1),
    }),
  TYPEORM_MIGRATIONS_RUN: Joi.string().valid('true', 'false').optional(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6380),
  MEMGRAPH_URI: Joi.string().default('bolt://localhost:7687'),

  // LLM config — all movable to DB; env acts as first-boot fallback.
  OPENAI_API_KEY: Joi.string().optional().allow(''),
  LLM_PROVIDER: Joi.string().valid('auto', 'openai', 'openrouter', 'local').optional().default('auto'),
  OPENAI_BASE_URL: Joi.string().optional().allow(''),
  OPENAI_CHAT_MODEL: Joi.string().optional().allow(''),
  OPENAI_EMBEDDING_MODEL: Joi.string().optional().allow(''),
  OPENAI_EMBEDDING_DIMENSIONS: Joi.number().optional().default(1536),
  LLM_HEALTH_CHECK_ENABLED: Joi.string().valid('true', 'false').optional().default('true'),
  ANTHROPIC_API_KEY: Joi.string().optional().allow(''),

  // GitHub — all movable to DB.
  GITHUB_TOKEN: Joi.string().optional().allow(''),
  GITHUB_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  GITHUB_CLIENT_ID: Joi.string().optional().allow(''),
  GITHUB_CLIENT_SECRET: Joi.string().optional().allow(''),
  GITHUB_CALLBACK_URL: Joi.string().optional().allow(''),
  GITHUB_APP_ID: Joi.string().optional().allow(''),
  GITHUB_APP_PRIVATE_KEY: Joi.string().optional().allow(''),

  // App (hybrid — env default, DB override).
  PUBLIC_API_BASE_URL: Joi.string().optional().allow(''),
  FRONTEND_APP_URL: Joi.string().optional().allow(''),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),

  // Feature flags — movable to DB; FILE_WATCH_ENABLED is read at service
  // init so UI toggles need a restart (surfaced as a "requires restart"
  // badge in the Settings UI).
  FILE_WATCH_ENABLED: Joi.string().valid('true', 'false').default('false'),
  AGENT_PR_ENABLED: Joi.string().valid('true', 'false').optional().default('false'),
  AGENT_SCAN_ON_PUSH: Joi.string().valid('true', 'false').optional().default('false'),
  AGENT_HEALTH_CRON: Joi.string().optional().allow(''),
  AGENT_MAX_RUNS_PER_HOUR: Joi.number().optional().default(3),

  // Master key for `CryptoService` (AES-256-GCM). Decodes to 32 bytes
  // (base64 length = 44). Required in production. Dev/CI can boot without
  // it as long as no secret rows are touched — CryptoService throws
  // clearly on the first encrypt/decrypt call when unset.
  // Generate with: openssl rand -base64 32
  SETTINGS_ENCRYPTION_KEY: Joi.string().base64().length(44).optional().allow(''),
});
