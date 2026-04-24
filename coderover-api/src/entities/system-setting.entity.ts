import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('system_settings')
export class SystemSetting {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'jsonb', nullable: true })
  value!: string | number | boolean | Record<string, unknown> | null;

  @Column({ name: 'is_secret', default: false })
  isSecret!: boolean;

  /**
   * True when `value` is an EncryptedEnvelope (see
   * `src/common/crypto/crypto.service.ts`) rather than the plaintext of the
   * setting. Added by migration 016. Kept redundant with the envelope's own
   * `{encrypted:true}` flag so ops queries can filter without JSONB parsing.
   */
  @Column({ default: false })
  encrypted!: boolean;

  @Column({ default: 1 })
  version!: number;

  @Column({ name: 'updated_by', type: 'text', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
