import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from './config/config.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { IngestModule } from './ingest/ingest.module';
import { CopilotModule } from './copilot/copilot.module';
import { SearchModule } from './search/search.module';
import { McpModule } from './mcp/mcp.module';
import { PrReviewModule } from './pr-review/pr-review.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RepoModule } from './repo/repo.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { FileWatcherModule } from './watcher/file-watcher.module';
import { GraphModule } from './graph/graph.module';
import { HealthModule } from './health/health.module';
import { DebugModule } from './debug/debug.module';
import { AdminConfigModule } from './admin/admin-config.module';
import { GitHubIntegrationModule } from './github-integration/github-integration.module';
import { AgentModule } from './agent/agent.module';
import { AgentMemoryModule } from './agent/agent-memory/agent-memory.module';
import { AgentPrModule } from './agent/agent-pr/agent-pr.module';
import { AgentEnforcerModule } from './agent/agent-enforcer/agent-enforcer.module';
import { AgentRefactorModule } from './agent/agent-refactor/agent-refactor.module';
import { AgentApprovalModule } from './agent/agent-approval/agent-approval.module';
import { AgentOrchestratorModule } from './agent/agent-orchestrator/agent-orchestrator.module';
import { AgentHealthModule } from './agent/agent-health/agent-health.module';
import { EventsModule } from './events/events.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ObservabilityModule } from './observability/observability.module';
import { PluginsModule } from './plugins/plugins.module';
import { CitationsModule } from './citations/citations.module';

@Module({
  imports: [
    AppConfigModule,
    CryptoModule,
    DatabaseModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6380),
        },
      }),
    }),
    AuthModule,
    IngestModule,
    CopilotModule,
    SearchModule,
    McpModule,
    PrReviewModule,
    AnalyticsModule,
    RepoModule,
    ArtifactsModule,
    FileWatcherModule,
    GraphModule,
    HealthModule,
    DebugModule,
    AdminConfigModule,
    GitHubIntegrationModule,
    AgentModule,
    AgentMemoryModule,
    AgentPrModule,
    AgentEnforcerModule,
    AgentRefactorModule,
    AgentApprovalModule,
    AgentOrchestratorModule,
    AgentHealthModule,
    EventsModule,
    OrganizationsModule,
    ObservabilityModule,
    PluginsModule,
    CitationsModule,
  ],
})
export class AppModule {}
