import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CodeChunk } from '../entities/code-chunk.entity';
import { ChatSession } from '../entities/chat-session.entity';
import { ChatMessage } from '../entities/chat-message.entity';
import { PrReview } from '../entities/pr-review.entity';
import { SyncLog } from '../entities/sync-log.entity';
import { Repo } from '../entities/repo.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';
import { ContextArtifact } from '../artifacts/context-artifact.entity';
import { SystemSetting } from '../entities/system-setting.entity';
import { SettingAudit } from '../entities/setting-audit.entity';
import { GithubConnection } from '../entities/github-connection.entity';
import { CodeMethod } from '../entities/code-method.entity';
import { CodeCall } from '../entities/code-call.entity';
import { CodeInheritance } from '../entities/code-inheritance.entity';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentApproval } from '../entities/agent-approval.entity';
import { AgentMemory } from '../entities/agent-memory.entity';
import { AgentRule } from '../entities/agent-rule.entity';
import { User } from '../entities/user.entity';
import { Organization } from '../entities/organization.entity';
import { OrgMembership } from '../entities/org-membership.entity';
import { RagCitation } from '../entities/rag-citation.entity';
import { PrReviewFinding } from '../entities/pr-review-finding.entity';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { GraphMigration } from '../entities/graph-migration.entity';
import { RevokedToken } from '../entities/revoked-token.entity';
import { CacheEntry } from '../entities/cache-entry.entity';
import { LLMAuditLog } from '../entities/llm-audit-log.entity';

const logger = new Logger('DatabaseModule');

const ENTITIES = [
  CodeChunk,
  ChatSession,
  ChatMessage,
  PrReview,
  SyncLog,
  Repo,
  WebhookEvent,
  ContextArtifact,
  SystemSetting,
  SettingAudit,
  GithubConnection,
  CodeMethod,
  CodeCall,
  CodeInheritance,
  AgentRun,
  AgentApproval,
  AgentMemory,
  AgentRule,
  User,
  Organization,
  OrgMembership,
  RagCitation,
  PrReviewFinding,
  EdgeProducerAudit,
  GraphMigration,
  RevokedToken,
  CacheEntry,
  LLMAuditLog,
];

const MIGRATIONS_GLOB = join(__dirname, 'migrations', '*{.ts,.js}');

/**
 * Phase 5 (Zero Trust): when boot-time auto-migrate is enabled AND a
 * separate migrate user is configured, open a one-shot DataSource as
 * `coderover_migrate`, run any pending migrations, then close it. The
 * runtime DataSource (returned to TypeORM below) connects as the
 * lower-privileged `coderover_app` and CANNOT do DDL.
 *
 * Falls back gracefully when DATABASE_MIGRATE_USER is unset — runs
 * migrations as the runtime user, matching pre-Phase-5 behavior. This
 * keeps existing dev/CI setups working without an env change while
 * giving operators a clean path to opt into role separation.
 */
async function runPendingMigrations(configService: ConfigService): Promise<void> {
  const migrateUser =
    configService.get<string>('DATABASE_MIGRATE_USER') ||
    configService.get<string>('DATABASE_USER');
  const migratePassword =
    configService.get<string>('DATABASE_MIGRATE_PASSWORD') ||
    configService.get<string>('DATABASE_PASSWORD');

  const usingDedicatedMigrateUser =
    !!configService.get<string>('DATABASE_MIGRATE_USER');

  logger.log(
    `Running migrations as ${usingDedicatedMigrateUser ? `'${migrateUser}' (dedicated)` : `'${migrateUser}' (shared with runtime)`}`,
  );

  const migrateDataSource = new DataSource({
    type: 'postgres',
    host: configService.get<string>('DATABASE_HOST'),
    port: configService.get<number>('DATABASE_PORT'),
    database: configService.get<string>('DATABASE_NAME'),
    username: migrateUser,
    password: migratePassword,
    entities: [],
    migrations: [MIGRATIONS_GLOB],
    synchronize: false,
    logging: configService.get<string>('NODE_ENV') === 'development',
  });

  await migrateDataSource.initialize();
  try {
    await migrateDataSource.runMigrations();
  } finally {
    await migrateDataSource.destroy();
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const runMigrationsOnBoot =
          configService.get<string>('TYPEORM_MIGRATIONS_RUN') === 'true' ||
          configService.get<string>('NODE_ENV') === 'development';

        if (runMigrationsOnBoot) {
          await runPendingMigrations(configService);
        }

        return {
          type: 'postgres',
          host: configService.get<string>('DATABASE_HOST'),
          port: configService.get<number>('DATABASE_PORT'),
          database: configService.get<string>('DATABASE_NAME'),
          username: configService.get<string>('DATABASE_USER'),
          password: configService.get<string>('DATABASE_PASSWORD'),
          entities: ENTITIES,
          // Migrations are run by `runPendingMigrations` above as the
          // dedicated migrate user (when configured). The runtime
          // connection — coderover_app — must NOT have migrationsRun
          // enabled, both because it lacks DDL privileges and because
          // running migrations twice on boot is wasteful.
          migrations: [MIGRATIONS_GLOB],
          migrationsRun: false,
          synchronize: false,
          logging: configService.get<string>('NODE_ENV') === 'development',
        };
      },
    }),
  ],
})
export class DatabaseModule {}
