import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { encryptedString } from '../common/crypto/encrypted-string.transformer';

@Entity('repos')
export class Repo {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner' })
  owner!: string;

  @Column({ name: 'name' })
  name!: string;

  @Column({ name: 'full_name', unique: true })
  fullName!: string;

  // Phase 2A (Zero Trust): legacy per-repo PAT, AES-256-GCM encrypted at
  // rest via the `encryptedString` transformer. Reads return plaintext,
  // writes encrypt before insert/update. Pre-existing plaintext rows pass
  // through unchanged on read and are re-encrypted on next save.
  @Column({ name: 'github_token', nullable: true, transformer: encryptedString })
  githubToken!: string;

  @Column({ name: 'branch', default: 'main' })
  branch!: string;

  @Column({ name: 'label', nullable: true })
  label!: string;

  @Column({ name: 'language', nullable: true })
  language!: string;

  @Column({ name: 'file_count', default: 0 })
  fileCount!: number;

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Column({ name: 'agent_config', type: 'jsonb', default: {} })
  agentConfig!: Record<string, any>;

  /** Phase 9: owning organization. Nullable during rollout. */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;

  /**
   * Phase 10 (2026-04-16): when set, this repo was registered via the
   * GitHub OAuth dropdown. `GitHubTokenResolver` fetches a fresh access
   * token from `github_connections[user_id=this]` at every API call so
   * revocations and rotations take effect immediately. Null for repos
   * registered via the manual "Advanced: URL + PAT" path — those still
   * use `github_token`.
   */
  @Column({ name: 'connected_by_user_id', type: 'uuid', nullable: true })
  connectedByUserId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
