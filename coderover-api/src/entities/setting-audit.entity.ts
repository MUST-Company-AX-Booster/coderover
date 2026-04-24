import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('setting_audits')
export class SettingAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'setting_key', type: 'text' })
  settingKey!: string;

  @Column({ name: 'previous_value', type: 'jsonb', nullable: true })
  previousValue!: string | number | boolean | Record<string, unknown> | null;

  @Column({ name: 'next_value', type: 'jsonb', nullable: true })
  nextValue!: string | number | boolean | Record<string, unknown> | null;

  @Column({ default: 1 })
  version!: number;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'updated_by', type: 'text' })
  updatedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
