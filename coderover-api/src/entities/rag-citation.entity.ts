import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ChatMessage } from './chat-message.entity';

export type ConfidenceTag = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

@Entity('rag_citations')
export class RagCitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ChatMessage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chat_message_id' })
  chatMessage!: ChatMessage;

  @Index('idx_rag_citations_chat_message_id')
  @Column({ name: 'chat_message_id', type: 'uuid' })
  chatMessageId!: string;

  @Index('idx_rag_citations_org_id')
  @Column({ name: 'org_id', type: 'uuid' })
  orgId!: string;

  @Column({ name: 'file_path', type: 'text' })
  filePath!: string;

  @Column({ name: 'line_start', type: 'int', nullable: true })
  lineStart!: number | null;

  @Column({ name: 'line_end', type: 'int', nullable: true })
  lineEnd!: number | null;

  @Column({ type: 'double precision', nullable: true })
  similarity!: number | null;

  @Index('idx_rag_citations_confidence')
  @Column({ type: 'enum', enum: ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'], default: 'AMBIGUOUS' })
  confidence!: ConfidenceTag;

  @Column({ name: 'confidence_score', type: 'double precision', nullable: true })
  confidenceScore!: number | null;

  @Column({ name: 'evidence_ref', type: 'jsonb', nullable: true })
  evidenceRef!: any;

  @Column({ type: 'text', nullable: true })
  producer!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
