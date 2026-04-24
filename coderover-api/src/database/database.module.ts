import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
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

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DATABASE_HOST'),
        port: configService.get<number>('DATABASE_PORT'),
        database: configService.get<string>('DATABASE_NAME'),
        username: configService.get<string>('DATABASE_USER'),
        password: configService.get<string>('DATABASE_PASSWORD'),
        entities: [
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
        ],
        migrations: [join(__dirname, '..', 'database', 'migrations', '*{.ts,.js}')],
        migrationsRun:
          configService.get<string>('TYPEORM_MIGRATIONS_RUN') === 'true' ||
          configService.get<string>('NODE_ENV') === 'development',
        synchronize: false,
        logging: configService.get<string>('NODE_ENV') === 'development',
      }),
    }),
  ],
})
export class DatabaseModule {}
