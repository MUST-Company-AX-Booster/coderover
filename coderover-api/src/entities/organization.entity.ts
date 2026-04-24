import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { OrgMembership } from './org-membership.entity';

@Entity({ name: 'organizations' })
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug!: string;

  @Column({ type: 'integer', nullable: true, name: 'monthly_token_cap' })
  monthlyTokenCap!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @OneToMany(() => OrgMembership, m => m.organization)
  memberships!: OrgMembership[];
}
