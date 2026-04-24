import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type TokenKind = 'user' | 'mcp';

/**
 * Phase 10 A4 — One row per JWT we track (issued via `POST /auth/tokens`).
 *
 * The entity's `id` is the JWT's `jti` claim. `revoked_at IS NULL` → active.
 * Non-null → revoked; the row is kept for audit + UI history.
 *
 * Legacy tokens (pre-A4, no `jti`) never appear in this table — the guard
 * skips the revocation check when `jti` is absent so existing sessions
 * don't break on rollout.
 */
@Entity('revoked_tokens')
export class RevokedToken {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  kind!: TokenKind;

  @Column({ type: 'jsonb', nullable: true })
  scope!: string[] | null;

  @Column({ type: 'text', nullable: true })
  label!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Index('idx_revoked_tokens_org_revoked')
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
