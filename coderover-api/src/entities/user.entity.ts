import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Role } from '../auth/roles.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ nullable: true })
  name?: string;

  @Column({ nullable: true })
  passwordHash?: string;

  @Column({ type: 'enum', enum: Role, default: Role.User })
  role!: Role;

  @Column({ nullable: true })
  githubId?: string;

  @Column({ nullable: true })
  refreshToken?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
