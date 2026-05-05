import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';

/**
 * Phase 4B (Zero Trust): record one row per outbound LLM call.
 *
 * Design constraints:
 *
 *   1. **Fire-and-forget**. The user's request must never fail because
 *      audit logging failed. `record()` returns a `Promise<void>` but
 *      the caller can drop it on the floor — internal errors are
 *      caught and logged, never re-thrown.
 *
 *   2. **Privacy by default**. We store SHA256 hashes of prompt and
 *      response, never the raw text. Char counts and token counts
 *      provide size analytics; the per-pattern redaction map
 *      (carried over from `LLMResponseValidatorService`) provides
 *      credential-leakage signal without retaining the original
 *      strings.
 *
 *   3. **Hot-path-cheap**. SHA256 of a 100KB prompt is ~ms, the INSERT
 *      is one round-trip. Both happen off the critical path of the
 *      response stream.
 *
 * Used by every LLM call site (initial integration: copilot/chat).
 */

export interface AuditRecordInput {
  /** Owning org. Null for system / unscoped calls. */
  orgId?: string | null;
  /** User who triggered the call. Null for background jobs. */
  userId?: string | null;
  /** Stable call-site identifier (e.g. 'copilot.chat', 'embedder.batch'). */
  callSite: string;
  /** Provider (`openai` / `anthropic` / `local` / `openrouter` / etc). */
  provider: string;
  /** Model identifier as sent to the provider. */
  model: string;
  /** The full prompt text — hashed, never persisted. */
  promptText: string;
  /** The full response text — hashed, never persisted. Null for blocked / errored calls. */
  responseText?: string | null;
  /** Token usage from the provider, when available. */
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  /** Wall-clock duration from request start to response complete. */
  latencyMs?: number | null;
  /** True when the kill switch rejected the call before it reached the provider. */
  killSwitchBlocked?: boolean;
  /** Per-credential-pattern redaction count from the response validator. */
  redactions?: Record<string, number>;
  /** Error message if the call failed. Null on success. */
  error?: string | null;
}

@Injectable()
export class LLMAuditService {
  private readonly logger = new Logger(LLMAuditService.name);

  constructor(
    @InjectRepository(LLMAuditLog)
    private readonly repo: Repository<LLMAuditLog>,
  ) {}

  /**
   * Record one audit row. Fire-and-forget — caller can `void`-ignore
   * the returned promise. Internal failures are logged at warn level
   * and swallowed so an upstream user request is never broken by an
   * audit-table outage.
   */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      const promptHash = sha256(input.promptText);
      // Distinguish "no response" (null/undefined → null hash, null chars)
      // from "empty response" (`""` → hash of empty string, 0 chars).
      // An empty string is still a valid response and should be recorded
      // as such — only a literal null/undefined means the call never
      // produced a response (kill switch, error, etc.).
      const responseHash = input.responseText != null ? sha256(input.responseText) : null;
      const responseChars = input.responseText != null ? input.responseText.length : null;

      await this.repo.insert({
        orgId: input.orgId ?? null,
        userId: input.userId ?? null,
        callSite: input.callSite,
        provider: input.provider,
        model: input.model,
        promptHash,
        responseHash,
        promptChars: input.promptText.length,
        responseChars,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        latencyMs: input.latencyMs ?? null,
        killSwitchBlocked: input.killSwitchBlocked ?? false,
        redactions: input.redactions ?? {},
        error: input.error ?? null,
      });
    } catch (err) {
      // NEVER throw. Audit failures must not block the user request.
      this.logger.warn(
        `LLM audit insert failed (${input.callSite}/${input.model}): ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Hash a string with SHA256 — used for prompt + response identifiers in
 * the audit log. Exported so call sites can pre-compute if they want
 * to (e.g. for dedup detection in the same request scope).
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
