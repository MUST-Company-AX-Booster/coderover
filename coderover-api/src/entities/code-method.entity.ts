import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('code_methods')
export class CodeMethod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'repo_id', nullable: true })
  repoId!: string;

  @Column({ name: 'file_path' })
  filePath!: string;

  @Column({ name: 'class_name' })
  className!: string;

  @Column({ name: 'method_name' })
  methodName!: string;

  @Column({ name: 'start_line', nullable: true })
  startLine!: number;

  @Column({ name: 'end_line', nullable: true })
  endLine!: number;

  @Column({ name: 'parameters', type: 'jsonb', default: [] })
  parameters!: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
