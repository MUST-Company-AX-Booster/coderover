import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { AgentModule } from '../agent.module';
import { PrReviewModule } from '../../pr-review/pr-review.module';
import { IngestModule } from '../../ingest/ingest.module';
import { AgentPrService } from './agent-pr.service';
import { AgentPrProcessor } from './agent-pr.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'agent-pr-review',
    }),
    ConfigModule,
    AgentModule,
    PrReviewModule,
    IngestModule,
  ],
  providers: [AgentPrService, AgentPrProcessor],
  exports: [AgentPrService],
})
export class AgentPrModule {}
