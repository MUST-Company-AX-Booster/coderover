import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  const analyticsService = {
    getSummary: jest.fn().mockResolvedValue({ repos: { total: 1 }, codebase: { totalChunks: 10 } }),
    getDashboardSnapshot: jest.fn().mockResolvedValue({
      stats: {
        totalRepos: 1,
        totalChunks: 10,
        totalArtifacts: 2,
        activeSessions: 1,
        lastSyncAt: null,
        systemHealth: 'healthy',
      },
      dailyUsage: [],
      repoStats: [],
      languageDistribution: [],
      topQueries: [],
      systemMetrics: {
        totalChats: 0,
        totalSearches: 0,
        activeUsers: 0,
        avgResponseTime: 0,
        totalChunks: 10,
        totalArtifacts: 2,
      },
      recentActivity: [],
      generatedAt: new Date().toISOString(),
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: AnalyticsService, useValue: analyticsService }],
    }).compile();

    controller = module.get<AnalyticsController>(AnalyticsController);
  });

  it('returns summary payload', async () => {
    const result = await controller.getSummary();
    expect(result).toHaveProperty('repos');
    expect(analyticsService.getSummary).toHaveBeenCalled();
  });

  it('returns dashboard snapshot payload', async () => {
    const result = await controller.getDashboard('7d');
    expect(result).toHaveProperty('stats');
    expect(analyticsService.getDashboardSnapshot).toHaveBeenCalledWith('7d');
  });

  it('returns timeseries payload', async () => {
    const result = await controller.getTimeSeries('7d');
    expect(result).toHaveProperty('dailyUsage');
    expect(result).toHaveProperty('languageDistribution');
  });
});
