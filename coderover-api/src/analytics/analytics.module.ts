import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { Repo } from '../entities/repo.entity';
import { PrReview } from '../entities/pr-review.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Repo, PrReview, WebhookEvent])],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
