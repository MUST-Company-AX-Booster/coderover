import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('code_calls')
export class CodeCall {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'repo_id', nullable: true })
  repoId!: string;

  @Column({ name: 'caller_file' })
  callerFile!: string;

  @Column({ name: 'caller_name' })
  callerName!: string;

  @Column({ name: 'caller_kind' })
  callerKind!: string; // 'function' | 'method'

  @Column({ name: 'callee_name' })
  calleeName!: string;

  @Column({ name: 'callee_qualified', nullable: true })
  calleeQualified!: string;

  @Column({ name: 'call_line', nullable: true })
  callLine!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
