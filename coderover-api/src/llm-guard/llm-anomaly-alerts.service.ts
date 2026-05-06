import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';

/**
 * Phase 4C (Zero Trust): periodic anomaly detection over `llm_audit_log`.
 *
 * Runs every N minutes (default 5), computes three signals over a sliding
 * window, and emits a structured warn-level log line for every threshold
 * breach. Operators can pipe the warn stream into their existing alert
 * sink (Loki + Alertmanager, Datadog, Pager).
 *
 * Signals + their default thresholds:
 *
 *   1. **Token-rate spike per org** — sum(total_tokens) over the last hour
 *      per org. Default threshold: 100,000 tokens. Catches a runaway
 *      prompt loop or a customer stress test before the bill arrives.
 *
 *   2. **Sustained credential redactions per call_site** — count of rows
 *      where `redactions != '{}'` over the last hour, grouped by
 *      call_site. Default: 10. A high count means the validator is
 *      actively scrubbing real-shape secrets — either prompt-injection
 *      is succeeding, or the model is hallucinating real-shape tokens
 *      from training data. Either way: investigate.
 *
 *   3. **Kill-switch-block volume** — count of `kill_switch_blocked = true`
 *      rows over the last hour. Default: 50. Engagement is normally
 *      operator-driven, but a sustained high count when no operator
 *      engaged is evidence of a misconfiguration or a deploy that
 *      flipped the env var by accident.
 *
 * Set any threshold to 0 to disable that signal.
 *
 * Phase 4D add-ons (in this file):
 *
 *   - **Webhook sink.** Set `ANOMALY_WEBHOOK_URL` to POST every
 *     surviving alert as JSON. Optional `ANOMALY_WEBHOOK_AUTH_HEADER`
 *     for `Authorization`. Default timeout 5s, configurable via
 *     `ANOMALY_WEBHOOK_TIMEOUT_MS`. Fire-and-forget — sink failures
 *     warn-log and don't break the sweep.
 *
 *   - **Per-(signal, scope) cooldown.** Default 30 minutes. A
 *     sustained breach pages once-per-cooldown instead of every
 *     sweep, which is what most ops teams want during an incident.
 *     Set `ANOMALY_COOLDOWN_MINUTES=0` to disable (re-fire every
 *     sweep — useful for testing or if you've routed alerts through
 *     a downstream dedup'er).
 *
 * The full env surface:
 *
 *   ANOMALY_CHECK_INTERVAL_MS         — default 300_000 (5 min)
 *   ANOMALY_WINDOW_MINUTES            — default 60      (look-back window)
 *   ANOMALY_TOKEN_RATE_PER_ORG        — default 100_000 tokens/window
 *   ANOMALY_REDACTIONS_PER_CALL_SITE  — default 10 rows/window
 *   ANOMALY_KILL_SWITCH_BLOCKS        — default 50 rows/window
 *   ANOMALY_COOLDOWN_MINUTES          — default 30 (Phase 4D)
 *   ANOMALY_WEBHOOK_URL               — unset = sink off (Phase 4D)
 *   ANOMALY_WEBHOOK_AUTH_HEADER       — optional (Phase 4D)
 *   ANOMALY_WEBHOOK_TIMEOUT_MS        — default 5_000 (Phase 4D)
 */

interface AnomalySignal {
  signal:
    | 'llm_anomaly.token_rate_spike'
    | 'llm_anomaly.sustained_redactions'
    | 'llm_anomaly.kill_switch_volume';
  scope: Record<string, string>; // e.g. { org_id: '...' } or { call_site: '...' }
  metric: number;
  threshold: number;
  windowMinutes: number;
  observedAt: string;
}

const DEFAULTS = {
  intervalMs: 5 * 60 * 1_000,
  windowMinutes: 60,
  tokenRatePerOrg: 100_000,
  redactionsPerCallSite: 10,
  killSwitchBlocks: 50,
  cooldownMinutes: 30,
  webhookTimeoutMs: 5_000,
};

@Injectable()
export class LLMAnomalyAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LLMAnomalyAlertsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Phase 4D: per-(signal, scope) last-fired timestamps for cooldown
   * suppression. In-memory by design — losing this on restart means
   * the next sweep will re-fire any active alerts once, which is the
   * right behavior (operators want to know about ongoing breaches
   * after a deploy). For multi-instance deployments where dedup
   * matters across replicas, this would need to move to Redis; the
   * single-process case covers our current topology.
   */
  private readonly cooldownState = new Map<string, number>();

  constructor(
    @InjectRepository(LLMAuditLog)
    private readonly repo: Repository<LLMAuditLog>,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getNumber('ANOMALY_CHECK_INTERVAL_MS', DEFAULTS.intervalMs);
    if (intervalMs <= 0) {
      this.logger.log(
        'LLM anomaly alerts disabled (ANOMALY_CHECK_INTERVAL_MS <= 0)',
      );
      return;
    }
    // Defer the first sweep to after boot so DB connections are warm
    // and we don't race the migration runner. The .unref() means the
    // timer never holds the event loop open by itself.
    this.timer = setInterval(() => {
      this.runSweep().catch(err => {
        this.logger.warn(
          `LLM anomaly sweep errored: ${(err as Error).message}`,
        );
      });
    }, intervalMs);
    this.timer.unref();
    this.logger.log(
      `LLM anomaly alerts active — sweep every ${intervalMs}ms`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Public for tests — invoke a single sweep without waiting for the
   * interval. Called by the scheduled timer in production and by unit
   * tests with a stub repo.
   */
  async runSweep(): Promise<AnomalySignal[]> {
    const windowMinutes = this.getNumber(
      'ANOMALY_WINDOW_MINUTES',
      DEFAULTS.windowMinutes,
    );
    const since = new Date(Date.now() - windowMinutes * 60 * 1_000);

    const alerts: AnomalySignal[] = [];

    const tokenAlerts = await this.checkTokenRatePerOrg(since, windowMinutes);
    const redactionAlerts = await this.checkSustainedRedactions(
      since,
      windowMinutes,
    );
    const killSwitchAlerts = await this.checkKillSwitchVolume(
      since,
      windowMinutes,
    );

    alerts.push(...tokenAlerts, ...redactionAlerts, ...killSwitchAlerts);

    // Phase 4D: cooldown filter + webhook sink. Cooldown suppresses
    // repeat alerts for the same (signal, scope) within the window so
    // a sustained breach pages once-per-cooldown instead of every
    // sweep. Sink fires fire-and-forget per surviving alert. Both are
    // env-toggleable; defaults preserve pre-Phase-4D log-only behavior
    // when unset.
    //
    // Per-sweep config is read ONCE here, not per alert in the filter
    // / forEach. ConfigService.get is cheap, but env reads inside an
    // inner loop are still wasteful and gemini-code-assist on PR #68
    // flagged the pattern. Cleaner is also easier to follow.
    const cooldownMinutes = this.getNumber(
      'ANOMALY_COOLDOWN_MINUTES',
      DEFAULTS.cooldownMinutes,
    );
    const webhookCfg = this.resolveWebhookConfig();
    const fireable = alerts.filter((a) => this.passCooldown(a, cooldownMinutes));

    for (const alert of fireable) {
      this.logger.warn(JSON.stringify(alert));
      if (webhookCfg) void this.sendWebhook(alert, webhookCfg);
    }

    return fireable;
  }

  /**
   * Cooldown gate. Returns `true` if this alert should fire (and
   * stamps the timestamp); `false` if we're still inside the cooldown
   * window for this (signal, scope) and the alert should be
   * suppressed. `cooldownMinutes <= 0` disables cooldown — every
   * sweep re-fires.
   */
  private passCooldown(alert: AnomalySignal, cooldownMinutes: number): boolean {
    if (cooldownMinutes <= 0) return true;

    // JSON.stringify with sorted keys would be more robust to scope
    // ordering, but our scopes are built in code with stable shape
    // (`{ org_id }` / `{ call_site }` / `{}`), so the simple
    // stringify is deterministic for the inputs we generate.
    const key = `${alert.signal}|${JSON.stringify(alert.scope)}`;
    const lastFiredAt = this.cooldownState.get(key);
    const now = Date.now();
    const cooldownMs = cooldownMinutes * 60 * 1_000;

    if (lastFiredAt !== undefined && now - lastFiredAt < cooldownMs) {
      return false;
    }
    this.cooldownState.set(key, now);
    return true;
  }

  /**
   * Resolve webhook config from env once per sweep. Returns null when
   * ANOMALY_WEBHOOK_URL is unset, which signals log-only mode and
   * lets the caller skip `sendWebhook` entirely instead of constructing
   * AbortControllers and headers per alert.
   */
  private resolveWebhookConfig(): {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
  } | null {
    const url = this.configService.get<string>('ANOMALY_WEBHOOK_URL');
    if (!url) return null;

    const authHeader = this.configService.get<string>('ANOMALY_WEBHOOK_AUTH_HEADER');
    const timeoutMs = this.getNumber(
      'ANOMALY_WEBHOOK_TIMEOUT_MS',
      DEFAULTS.webhookTimeoutMs,
    );

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    return { url, headers, timeoutMs };
  }

  /**
   * Fire-and-forget webhook POST. The caller (`runSweep`) prepares
   * `cfg` once and only calls this when a sink URL is configured —
   * matches the audit/sink pattern and avoids re-reading env per alert.
   *
   * Errors are warn-logged and swallowed: a sweep that detected real
   * anomalies must still emit its log line (we already did, before
   * calling this) even if the sink is down.
   */
  private async sendWebhook(
    alert: AnomalySignal,
    cfg: { url: string; headers: Record<string, string>; timeoutMs: number },
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: cfg.headers,
        body: JSON.stringify(alert),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `Anomaly webhook returned ${res.status} ${res.statusText} for ${alert.signal}`,
        );
      }
    } catch (err) {
      // Don't trust `err` to be an Error — `throw "string"` and
      // `throw { code: 'X' }` both reach this catch and `.message`
      // would silently render as `undefined` in the log.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Anomaly webhook POST failed for ${alert.signal}: ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sum total_tokens per org over the window. Alert any org over threshold. */
  private async checkTokenRatePerOrg(
    since: Date,
    windowMinutes: number,
  ): Promise<AnomalySignal[]> {
    const threshold = this.getNumber(
      'ANOMALY_TOKEN_RATE_PER_ORG',
      DEFAULTS.tokenRatePerOrg,
    );
    if (threshold <= 0) return [];

    // No `::int` cast on the SUM — Postgres returns `bigint` which the
    // node-postgres driver surfaces as a string. Casting to int4 in
    // SQL would throw "integer out of range" when an org's total
    // crosses ~2.1B tokens — exactly the runaway-loop scenario this
    // signal is designed to catch. JS `Number()` handles values up to
    // 2^53 safely, plenty of headroom.
    const rows = await this.repo
      .createQueryBuilder('al')
      .select('al.orgId', 'orgId')
      .addSelect('SUM(al.totalTokens)', 'total')
      .where('al.createdAt >= :since', { since })
      .andWhere('al.totalTokens IS NOT NULL')
      .andWhere('al.orgId IS NOT NULL')
      .groupBy('al.orgId')
      .having('SUM(al.totalTokens) >= :threshold', { threshold })
      .getRawMany<{ orgId: string; total: string | number }>();

    return rows.map(r => ({
      signal: 'llm_anomaly.token_rate_spike',
      scope: { org_id: r.orgId },
      metric: Number(r.total),
      threshold,
      windowMinutes,
      observedAt: new Date().toISOString(),
    }));
  }

  /** Count rows with non-empty redactions per call_site. Alert any over threshold. */
  private async checkSustainedRedactions(
    since: Date,
    windowMinutes: number,
  ): Promise<AnomalySignal[]> {
    const threshold = this.getNumber(
      'ANOMALY_REDACTIONS_PER_CALL_SITE',
      DEFAULTS.redactionsPerCallSite,
    );
    if (threshold <= 0) return [];

    // Same reasoning as the SUM query above — COUNT(*) returns bigint;
    // skip the SQL-level int4 cast and let JS `Number()` coerce.
    const rows = await this.repo
      .createQueryBuilder('al')
      .select('al.callSite', 'callSite')
      .addSelect('COUNT(*)', 'cnt')
      .where('al.createdAt >= :since', { since })
      .andWhere(`al.redactions <> '{}'::jsonb`)
      .groupBy('al.callSite')
      .having('COUNT(*) >= :threshold', { threshold })
      .getRawMany<{ callSite: string; cnt: string | number }>();

    return rows.map(r => ({
      signal: 'llm_anomaly.sustained_redactions',
      scope: { call_site: r.callSite },
      metric: Number(r.cnt),
      threshold,
      windowMinutes,
      observedAt: new Date().toISOString(),
    }));
  }

  /** Count kill_switch_blocked rows globally over the window. */
  private async checkKillSwitchVolume(
    since: Date,
    windowMinutes: number,
  ): Promise<AnomalySignal[]> {
    const threshold = this.getNumber(
      'ANOMALY_KILL_SWITCH_BLOCKS',
      DEFAULTS.killSwitchBlocks,
    );
    if (threshold <= 0) return [];

    const cnt = await this.repo
      .createQueryBuilder('al')
      .where('al.createdAt >= :since', { since })
      .andWhere('al.killSwitchBlocked = true')
      .getCount();

    if (cnt < threshold) return [];

    return [
      {
        signal: 'llm_anomaly.kill_switch_volume',
        scope: {},
        metric: cnt,
        threshold,
        windowMinutes,
        observedAt: new Date().toISOString(),
      },
    ];
  }

  /** Read a numeric env via ConfigService with a sensible default. */
  private getNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }
}
