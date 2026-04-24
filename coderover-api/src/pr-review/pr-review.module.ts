import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { PrReviewController } from './pr-review.controller';
import { PrReviewService } from './pr-review.service';
import { PrReview } from '../entities/pr-review.entity';
import { PrReviewFinding } from '../entities/pr-review-finding.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';
import { Repo } from '../entities/repo.entity';
import { GitHubService } from '../ingest/github.service';
import { GraphModule } from '../graph/graph.module';
import { SearchModule } from '../search/search.module';
import { EventsModule } from '../events/events.module';
import { GitHubIntegrationModule } from '../github-integration/github-integration.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PrReview, PrReviewFinding, WebhookEvent, Repo]),
    GraphModule,
    SearchModule,
    EventsModule,
    GitHubIntegrationModule,
    BullModule.registerQueue(
      { name: 'ingest' },
      { name: 'agent-pr-review' },
      { name: 'agent-health' },
    ),
  ],
  controllers: [PrReviewController],
  providers: [PrReviewService, GitHubService],
  exports: [PrReviewService],
})
export class PrReviewModule {}
