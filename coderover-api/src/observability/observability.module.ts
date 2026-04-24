import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { TokenCapService } from './token-cap.service';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, TokenCapService],
  exports: [MetricsService, TokenCapService],
})
export class ObservabilityModule {}
