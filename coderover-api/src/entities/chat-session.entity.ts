import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { ChatMessage } from './chat-message.entity';

@Entity('chat_sessions')
export class ChatSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ nullable: true })
  title!: string;

  @Column('uuid', { name: 'repo_ids', array: true, nullable: true })
  repoIds!: string[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @OneToMany(() => ChatMessage, (msg) => msg.session)
  messages!: ChatMessage[];

  /** Phase 9: owning organization. Nullable during rollout. */
  @Column({ name: 'org_id', type: 'uuid', nullable: true })
  orgId!: string | null;
}
