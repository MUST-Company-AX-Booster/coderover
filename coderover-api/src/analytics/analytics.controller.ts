import { Controller, Get, Header, Logger, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * GET /analytics/summary
   * Returns live stats: repos, indexed chunks, PR reviews, webhook events.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Get analytics summary counters' })
  @ApiOkResponse({
    description: 'Current platform analytics summary',
    schema: {
      example: {
        totalRepos: 3,
        activeRepos: 2,
        totalChunks: 4921,
        totalPrReviews: 14,
        totalWebhookEvents: 42,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getSummary() {
    this.logger.log('Analytics summary requested');
    return this.analyticsService.getSummary();
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard analytics snapshot with real metrics' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getDashboard(@Query('range') range?: string) {
    return this.analyticsService.getDashboardSnapshot(range || '7d');
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'Get analytics timeseries data for charts' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getTimeSeries(@Query('range') range?: string) {
    const snapshot = await this.analyticsService.getDashboardSnapshot(range || '7d');
    return {
      generatedAt: snapshot.generatedAt,
      dailyUsage: snapshot.dailyUsage,
      topQueries: snapshot.topQueries,
      repoStats: snapshot.repoStats,
      languageDistribution: snapshot.languageDistribution,
      systemMetrics: snapshot.systemMetrics,
      responseTimeSeries: snapshot.responseTimeSeries,
      responseTimeByRepo: snapshot.responseTimeByRepo,
    };
  }

  @Get('stream')
  @ApiOperation({ summary: 'Stream live dashboard analytics updates over SSE' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  async streamAnalytics(
    @Res() res: Response,
    @Query('range') range?: string,
    @Query('intervalMs') intervalMs?: string,
  ) {
    const safeInterval = Math.max(3000, Math.min(30000, Number(intervalMs) || 8000));
    const sendSnapshot = async () => {
      try {
        const snapshot = await this.analyticsService.getDashboardSnapshot(range || '7d');
        res.write(`event: snapshot\n`);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch (error) {
        res.write(`event: error\n`);
        res.write(
          `data: ${JSON.stringify({
            message: error instanceof Error ? error.message : 'Failed to load analytics snapshot',
          })}\n\n`,
        );
      }
    };

    await sendSnapshot();
    const timer = setInterval(sendSnapshot, safeInterval);

    res.on('close', () => {
      clearInterval(timer);
      res.end();
    });
  }
}
