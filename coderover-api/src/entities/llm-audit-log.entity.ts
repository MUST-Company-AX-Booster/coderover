import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Phase 4B (Zero Trust): per-call audit record for every outbound LLM
 * request. Each row is one call to one LLM endpoint, annotated with the
 * org / user that triggered it, the call site, model, hashed prompt &
 * response, token counts, latency, and the post-validator redaction
 * tally.
 *
 * What we DO NOT store:
 *   - Raw prompts. They commonly contain repo source code chunks and
 *     would inflate this table by orders of magnitude. Storing a sha256
 *     gives us repeat-prompt detection without retaining the bytes.
 *   - Raw responses. Same logic — sha256 instead. The post-validator
 *     redaction count is preserved separately so anomaly alerts can fire
 *     on credential leakage without keeping the original strings.
 *   - User identity beyond `user_id` FK.
 *
 * Indexes target the two access patterns Phase 4C alerts will use:
 *   - Recent rows for an org (rate / spike detection)
 *   - Rows where redactions were non-empty (credential-leakage alert)
 */
@Entity('llm_audit_log')
@Index('idx_llm_audit_org_created', ['orgId', 'createdAt'])
@Index('idx_llm_audit_call_site_created', ['callSite', 'createdAt'])
export class LLMAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Owning org. Nullable for system / unscoped calls (health checks). */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  /** User who triggered the call, if any. Null for background jobs. */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  /**
   * Short identifier for which code path made the call. Used by alerts
   * to slice traffic per surface. Free-form string by design — call sites
   * pick a stable name like `copilot.chat`, `embedder.batch`, etc.
   */
  @Column({ name: 'call_site', type: 'text' })
  callSite!: string;

  /** Provider name (`openai` / `anthropic` / `local` / `openrouter`). */
  @Column({ name: 'provider', type: 'text' })
  provider!: string;

  /** Model identifier as sent to the provider. */
  @Column({ name: 'model', type: 'text' })
  model!: string;

  /** SHA256 of the prompt text (or concatenated message bodies). */
  @Column({ name: 'prompt_hash', type: 'text' })
  promptHash!: string;

  /** SHA256 of the (post-validator) response text. */
  @Column({ name: 'response_hash', type: 'text', nullable: true })
  responseHash!: string | null;

  /** Total characters in the input prompt. */
  @Column({ name: 'prompt_chars', type: 'integer' })
  promptChars!: number;

  /** Total characters in the response. Null if the call errored. */
  @Column({ name: 'response_chars', type: 'integer', nullable: true })
  responseChars!: number | null;

  /** Token counts as reported by the provider (when available). */
  @Column({ name: 'prompt_tokens', type: 'integer', nullable: true })
  promptTokens!: number | null;

  @Column({ name: 'completion_tokens', type: 'integer', nullable: true })
  completionTokens!: number | null;

  @Column({ name: 'total_tokens', type: 'integer', nullable: true })
  totalTokens!: number | null;

  /** Wall-clock duration from request start to response complete. */
  @Column({ name: 'latency_ms', type: 'integer', nullable: true })
  latencyMs!: number | null;

  /**
   * `true` if the call was rejected by the kill switch BEFORE reaching
   * the provider. When true, response_hash, response_chars, latency_ms,
   * and token counts are null.
   */
  @Column({ name: 'kill_switch_blocked', type: 'boolean', default: false })
  killSwitchBlocked!: boolean;

  /**
   * Per-credential-pattern count of redactions applied by
   * LLMResponseValidatorService to the response. Empty `{}` when nothing
   * matched. Phase 4C alerts read this column for credential-leakage
   * detection.
   */
  @Column({ name: 'redactions', type: 'jsonb', default: {} })
  redactions!: Record<string, number>;

  /**
   * Set when the call errored. Stores the error MESSAGE only (not the
   * stack — too noisy and can leak path info). Null on success.
   */
  @Column({ name: 'error', type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
