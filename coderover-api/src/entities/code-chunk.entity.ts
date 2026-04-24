import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { SymbolInfo, ImportInfo } from '../ingest/ast.service';

@Entity('code_chunks')
export class CodeChunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'file_path' })
  filePath!: string;

  @Column({ name: 'module_name', nullable: true })
  moduleName!: string;

  @Column({ name: 'chunk_text', type: 'text' })
  chunkText!: string;

  @Column({ name: 'embedding', type: 'text', nullable: true })
  embedding!: string;

  @Column({ name: 'repo_id', nullable: true })
  repoId!: string;

  @Column({ name: 'commit_sha', nullable: true })
  commitSha!: string;

  @Column({ name: 'line_start', nullable: true })
  lineStart!: number;

  @Column({ name: 'line_end', nullable: true })
  lineEnd!: number;

  @Column({ name: 'symbols', type: 'jsonb', nullable: true })
  symbols!: SymbolInfo[] | null;

  @Column({ name: 'imports', type: 'jsonb', nullable: true })
  imports!: ImportInfo[] | null;

  @Column({ name: 'nest_role', type: 'text', nullable: true })
  nestRole!: string | null;

  @Column({ name: 'exports', type: 'jsonb', nullable: true })
  exports!: string[] | null;

  @Column({ name: 'language', type: 'text', nullable: true })
  language!: string | null;

  @Column({ name: 'framework', type: 'text', nullable: true })
  framework!: string | null;

  @Column({ name: 'artifact_type', type: 'text', default: 'source' })
  artifactType!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
