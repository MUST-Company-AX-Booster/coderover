import { Entity, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * Phase 10 B1 — Memgraph Cypher migration tracker.
 *
 * Memgraph has no native schema versioning. `GraphMigrationService` runs
 * pending Cypher migrations on app startup and records them here so they
 * run exactly once per deployment.
 */
@Entity('graph_migrations')
export class GraphMigration {
  @PrimaryColumn({ type: 'text' })
  name!: string;

  @CreateDateColumn({ name: 'applied_at' })
  appliedAt!: Date;
}
