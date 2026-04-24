import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';

export enum OrgRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
}

@Entity({ name: 'org_memberships' })
@Index(['orgId', 'userId'], { unique: true })
export class OrgMembership {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'org_id' })
  orgId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: OrgRole,
    enumName: 'org_role',
    default: OrgRole.MEMBER,
  })
  role!: OrgRole;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Organization, o => o.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  organization!: Organization;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
