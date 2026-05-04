import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptedString } from '../common/crypto/encrypted-string.transformer';
import { User } from './user.entity';

/**
 * Per-user GitHub OAuth connection. The unified OAuth flow (2026-04-16)
 * now keys this row by `users.id` (UUID) rather than the user's email.
 * Migration 017 converts the column type and adds the FK.
 *
 * Refresh-token columns are nullable because classic OAuth apps don't
 * return a refresh token (only GitHub App installs do). Expiries are
 * also nullable for the same reason.
 */
@Entity('github_connections')
export class GithubConnection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  // Phase 2A (Zero Trust): tokens are AES-256-GCM encrypted at rest via the
  // `encryptedString` transformer. Reads return plaintext, writes encrypt
  // before insert/update. Legacy plaintext rows are returned as-is and
  // re-encrypted on the next save (lazy migrate).
  @Column({ name: 'access_token', type: 'text', transformer: encryptedString })
  accessToken!: string;

  @Column({ name: 'refresh_token', type: 'text', nullable: true, transformer: encryptedString })
  refreshToken!: string | null;

  @Column({ name: 'access_token_expires_at', type: 'timestamptz', nullable: true })
  accessTokenExpiresAt!: Date | null;

  @Column({ name: 'refresh_token_expires_at', type: 'timestamptz', nullable: true })
  refreshTokenExpiresAt!: Date | null;

  @Column({ name: 'token_type', type: 'text', default: 'bearer' })
  tokenType!: string;

  @Column({ type: 'text', nullable: true })
  scope!: string | null;

  @Column({ name: 'github_login', type: 'text', nullable: true })
  githubLogin!: string | null;

  @Column({ name: 'github_id', type: 'text', nullable: true })
  githubId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
