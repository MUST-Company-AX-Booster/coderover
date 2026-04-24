import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MetricsService } from './metrics.service';

/**
 * Phase 9 / Workstream F: Per-org monthly token cap.
 *
 * Callers (AiClient boundary) should invoke recordUsage() after each
 * completion and guard() before kicking off large requests. Both are
 * no-ops when the org has no cap configured.
 */
@Injectable()
export class TokenCapService {
  private readonly logger = new Logger(TokenCapService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  private periodStart(date = new Date()): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    return d.toISOString().slice(0, 10); // YYYY-MM-01
  }

  async getUsage(orgId: string): Promise<{ prompt: number; completion: number; cap: number | null }> {
    const period = this.periodStart();
    const rows = await this.dataSource.query(
      `SELECT COALESCE(t.prompt_tokens, 0) AS prompt,
              COALESCE(t.completion_tokens, 0) AS completion,
              o.monthly_token_cap AS cap
       FROM organizations o
       LEFT JOIN token_usage_periods t ON t.org_id = o.id AND t.period_start = $2
       WHERE o.id = $1`,
      [orgId, period],
    );
    if (rows.length === 0) return { prompt: 0, completion: 0, cap: null };
    return {
      prompt: Number(rows[0].prompt) || 0,
      completion: Number(rows[0].completion) || 0,
      cap: rows[0].cap == null ? null : Number(rows[0].cap),
    };
  }

  async guard(orgId: string): Promise<void> {
    const { prompt, completion, cap } = await this.getUsage(orgId);
    if (cap == null) return;
    if (prompt + completion >= cap) {
      throw new ForbiddenException(
        `Monthly token cap reached (${prompt + completion}/${cap}). Contact your org owner.`,
      );
    }
  }

  async recordUsage(orgId: string, promptTokens: number, completionTokens: number): Promise<void> {
    const period = this.periodStart();
    // Emit Prometheus counter
    if (promptTokens > 0) {
      this.metrics.inc('coderover_ai_tokens_total', { org: orgId, kind: 'prompt' }, promptTokens);
    }
    if (completionTokens > 0) {
      this.metrics.inc('coderover_ai_tokens_total', { org: orgId, kind: 'completion' }, completionTokens);
    }
    await this.dataSource.query(
      `INSERT INTO token_usage_periods (org_id, period_start, prompt_tokens, completion_tokens)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, period_start)
       DO UPDATE SET
         prompt_tokens = token_usage_periods.prompt_tokens + EXCLUDED.prompt_tokens,
         completion_tokens = token_usage_periods.completion_tokens + EXCLUDED.completion_tokens,
         updated_at = now()`,
      [orgId, period, promptTokens, completionTokens],
    );
  }
}
