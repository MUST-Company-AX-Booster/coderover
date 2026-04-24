import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('code_inheritance')
export class CodeInheritance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'repo_id', nullable: true })
  repoId!: string;

  @Column({ name: 'file_path' })
  filePath!: string;

  @Column({ name: 'class_name' })
  className!: string;

  @Column({ name: 'extends_class', nullable: true })
  extendsClass!: string;

  @Column({ name: 'implements_interfaces', type: 'jsonb', default: [] })
  implementsInterfaces!: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
