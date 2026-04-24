import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ChatSession } from './chat-session.entity';

@Entity('chat_messages')
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ChatSession, (s) => s.messages)
  @JoinColumn({ name: 'session_id' })
  session!: ChatSession;

  @Column({ name: 'session_id' })
  sessionId!: string;

  @Column()
  role!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'tool_calls', type: 'jsonb', nullable: true })
  toolCalls!: any;

  @Column({ name: 'source_chunks', type: 'jsonb', nullable: true })
  sourceChunks!: any;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  /**
   * Phase 9: owning organization, inherited from parent session.
   * Added 2026-04-16 — migration 015 made this NOT NULL.
   */
  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;
}
