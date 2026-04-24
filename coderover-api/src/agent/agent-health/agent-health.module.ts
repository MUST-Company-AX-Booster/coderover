import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AgentHealthService } from './agent-health.service';
import { AgentHealthProcessor } from './agent-health.processor';
import { AgentModule } from '../agent.module';
import { AgentRefactorModule } from '../agent-refactor/agent-refactor.module';
import { AgentEnforcerModule } from '../agent-enforcer/agent-enforcer.module';
import { AnalyticsModule } from '../../analytics/analytics.module';
import { GraphModule } from '../../graph/graph.module';
import { RepoModule } from '../../repo/repo.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'agent-health',
    }),
    AgentModule,
    AgentRefactorModule,
    AgentEnforcerModule,
    AnalyticsModule,
    GraphModule,
    RepoModule,
    ConfigModule,
  ],
  providers: [AgentHealthService, AgentHealthProcessor],
  exports: [AgentHealthService],
})
export class AgentHealthModule {}
