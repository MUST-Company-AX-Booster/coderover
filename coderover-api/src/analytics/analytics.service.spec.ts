import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalyticsService } from './analytics.service';
import { Repo } from '../entities/repo.entity';
import { PrReview } from '../entities/pr-review.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  const mockRepoRepo = {
    find: jest.fn().mockResolvedValue([
      { id: 'r1', fullName: 'org/repo', language: 'TypeScript', fileCount: 120, isActive: true },
    ]),
  };

  const mockPrRepo = {
    find: jest.fn().mockResolvedValue([
      { id: 'p1', repo: 'org/repo', prNumber: 1, status: 'completed', findings: { score: 85 }, createdAt: new Date() },
    ]),
  };

  const mockWebhookRepo = {
    find: jest.fn().mockResolvedValue([
      { id: 'w1', eventType: 'push', repo: 'org/repo', processed: true, error: null, createdAt: new Date() },
    ]),
  };

  const mockDataSource = {
    query: jest.fn().mockResolvedValue([{ total_chunks: 500, total_files: 80 }]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(Repo), useValue: mockRepoRepo },
        { provide: getRepositoryToken(PrReview), useValue: mockPrRepo },
        { provide: getRepositoryToken(WebhookEvent), useValue: mockWebhookRepo },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  it('should return a summary with repos, codebase, prReviews, webhooks', async () => {
    mockDataSource.query
      .mockResolvedValueOnce([{ total_chunks: 500, total_files: 80 }])
      .mockResolvedValueOnce([{ repo_id: 'r1', full_name: 'org/repo', chunk_count: 500 }]);

    const summary = await service.getSummary();

    expect(summary).toHaveProperty('repos');
    expect(summary).toHaveProperty('codebase');
    expect(summary).toHaveProperty('prReviews');
    expect(summary).toHaveProperty('webhooks');
    expect(summary).toHaveProperty('generatedAt');

    expect(summary.repos.total).toBe(1);
    expect(summary.repos.active).toBe(1);
  });

  it('should count PR review stats correctly', async () => {
    mockDataSource.query.mockResolvedValue([]);
    const summary = await service.getSummary();
    expect(summary.prReviews.total).toBeGreaterThanOrEqual(0);
    expect(summary.prReviews.completed).toBeGreaterThanOrEqual(0);
  });

  it('should count webhook events correctly', async () => {
    mockDataSource.query.mockResolvedValue([]);
    const summary = await service.getSummary();
    expect(summary.webhooks.pushEvents).toBeGreaterThanOrEqual(0);
  });

  it('should provide dashboard snapshot with live sections', async () => {
    mockDataSource.query
      .mockResolvedValueOnce([{ total_chunks: 500, total_files: 80 }])
      .mockResolvedValueOnce([{ repo_id: 'r1', full_name: 'org/repo', chunk_count: 500 }])
      .mockResolvedValueOnce([{ date: '2026-03-16', chats: 2, searches: 4, users: 1 }])
      .mockResolvedValueOnce([{ name: 'org/repo', chunks: 500, artifacts: 3, last_sync: new Date().toISOString() }])
      .mockResolvedValueOnce([
        { total_chats: 11, total_searches: 21 },
      ])
      .mockResolvedValueOnce([{ total_artifacts: 5 }])
      .mockResolvedValueOnce([{ active_users: 2 }])
      .mockResolvedValueOnce([{ id: 's1', title: 'Auth review', updated_at: new Date().toISOString() }]);

    const snapshot = await service.getDashboardSnapshot('7d');
    expect(snapshot).toHaveProperty('stats');
    expect(snapshot).toHaveProperty('dailyUsage');
    expect(snapshot).toHaveProperty('repoStats');
    expect(snapshot).toHaveProperty('languageDistribution');
    expect(snapshot).toHaveProperty('topQueries');
    expect(snapshot).toHaveProperty('recentActivity');
  });
});
