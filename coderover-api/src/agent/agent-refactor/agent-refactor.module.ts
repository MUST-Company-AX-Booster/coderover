import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRefactorService } from './agent-refactor.service';
import { AgentRefactorController } from './agent-refactor.controller';
import { CodeChunk } from '../../entities/code-chunk.entity';
import { CodeMethod } from '../../entities/code-method.entity';
import { Repo } from '../../entities/repo.entity';
import { AgentModule } from '../agent.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { AgentApprovalModule } from '../agent-approval/agent-approval.module';
import { IngestModule } from '../../ingest/ingest.module';
import { ConfigModule } from '@nestjs/config';
import { AdminConfigModule } from '../../admin/admin-config.module';
import { GraphModule } from '../../graph/graph.module';
import { ObservabilityModule } from '../../observability/observability.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CodeChunk, CodeMethod, Repo]),
    AgentModule,
    AgentMemoryModule,
    forwardRef(() => AgentApprovalModule),
    IngestModule,
    ConfigModule,
    AdminConfigModule,
    GraphModule,
    ObservabilityModule,
  ],
  controllers: [AgentRefactorController],
  providers: [AgentRefactorService],
  exports: [AgentRefactorService],
})
export class AgentRefactorModule {}
