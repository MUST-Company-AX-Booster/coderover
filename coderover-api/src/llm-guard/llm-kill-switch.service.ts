import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Phase 4A (Zero Trust): emergency kill switch for every outbound LLM call.
 *
 * Two questions we want answered "yes" to:
 *
 *   1. If we discover that our LLM provider has a tampered model, or our
 *      prompt template has been backdoored, can an operator stop ALL LLM
 *      traffic in seconds — without an api redeploy?
 *
 *   2. When the switch is engaged, does every LLM call site fail loudly
 *      with a clear, actionable error rather than silently retrying?
 *
 * This service is the single chokepoint. Every LLM call site calls
 * `assertNotKilled()` BEFORE constructing the upstream request. If the
 * switch is on, we throw `LLMKillSwitchError` (a 503-mapped exception),
 * the call never reaches the network, and the user sees a clear message.
 *
 * Sources of truth (in evaluation order, first non-empty wins):
 *
 *   1. `LLM_KILL_SWITCH` env var — fastest to flip on a running container
 *      that supports env-reload. Truthy values: "1", "true", "yes", "on"
 *      (case-insensitive). Anything else (including empty / unset) means
 *      OFF.
 *
 * Future: SystemSetting-backed override for hot-toggle without env reload
 * is tracked as Phase 4B.
 *
 * Note on caching: we re-read `process.env` on every call. process.env
 * lookups are microsecond-cheap and avoiding caching is what makes the
 * switch responsive to runtime env changes (where the orchestrator
 * supports them).
 */

const ENV_VAR = 'LLM_KILL_SWITCH';

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export class LLMKillSwitchError extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      error: 'LLM Kill Switch Engaged',
      message:
        'LLM calls are temporarily disabled by an operator. Try again later, or contact your administrator if this persists.',
    });
  }
}

@Injectable()
export class LLMKillSwitchService {
  private readonly logger = new Logger(LLMKillSwitchService.name);

  /**
   * Throws `LLMKillSwitchError` if the kill switch is engaged. Call
   * BEFORE any LLM client request — throwing here means the request
   * never leaves the api process.
   */
  assertNotKilled(): void {
    if (this.isEngaged()) {
      // Log every blocked attempt at warn so the audit trail makes
      // engagement visible. We don't include the prompt/user here
      // because this method has no context — call sites should add
      // their own context log if needed.
      this.logger.warn(`LLM call rejected — ${ENV_VAR} engaged`);
      throw new LLMKillSwitchError();
    }
  }

  /**
   * Read-only check, intended for /health and admin diagnostics. Does
   * NOT throw. The implementation reads `process.env` fresh on every
   * call so a deploy that flips the env var sees an immediate response.
   */
  isEngaged(): boolean {
    const raw = process.env[ENV_VAR];
    if (!raw) return false;
    return TRUTHY.has(raw.trim().toLowerCase());
  }
}
