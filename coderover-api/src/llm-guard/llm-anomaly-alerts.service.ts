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
 * Thresholds are env-configurable so each environment can tune its own
 * baselines:
 *
 *   ANOMALY_CHECK_INTERVAL_MS         — default 300_000 (5 min)
 *   ANOMALY_WINDOW_MINUTES            — default 60      (look-back window)
 *   ANOMALY_TOKEN_RATE_PER_ORG        — default 100_000 tokens/window
 *   ANOMALY_REDACTIONS_PER_CALL_SITE  — default 10 rows/window
 *   ANOMALY_KILL_SWITCH_BLOCKS        — default 50 rows/window
 *
 * Set any threshold to 0 to disable that signal.
 *
 * Out of scope here (Phase 4D follow-ups):
 *   - Webhook / Slack / PagerDuty sink — today we only emit warn logs.
 *     The alert payload is already JSON-shaped so a sink integration is
 *     a small follow-up.
 *   - De-duplication / cooldown — the current loop will re-fire the same
 *     alert every 5 minutes while the breach persists. Cooldown is a
 *     small state machine on top of this; left out for v1 because it
 *     adds complexity and operators usually want repeat alerts during
 *     an incident anyway.
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
};

@Injectable()
export class LLMAnomalyAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LLMAnomalyAlertsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

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

    for (const alert of alerts) {
      this.logger.warn(JSON.stringify(alert));
    }

    return alerts;
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

    const rows = await this.repo
      .createQueryBuilder('al')
      .select('al.orgId', 'orgId')
      .addSelect('SUM(al.totalTokens)::int', 'total')
      .where('al.createdAt >= :since', { since })
      .andWhere('al.totalTokens IS NOT NULL')
      .andWhere('al.orgId IS NOT NULL')
      .groupBy('al.orgId')
      .having('SUM(al.totalTokens) >= :threshold', { threshold })
      .getRawMany<{ orgId: string; total: number }>();

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

    const rows = await this.repo
      .createQueryBuilder('al')
      .select('al.callSite', 'callSite')
      .addSelect('COUNT(*)::int', 'cnt')
      .where('al.createdAt >= :since', { since })
      .andWhere(`al.redactions <> '{}'::jsonb`)
      .groupBy('al.callSite')
      .having('COUNT(*) >= :threshold', { threshold })
      .getRawMany<{ callSite: string; cnt: number }>();

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
