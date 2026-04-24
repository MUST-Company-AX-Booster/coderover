import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalyticsService } from './analytics.service';
import { Repo } from '../entities/repo.entity';
import { PrReview } from '../entities/pr-review.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';

describe('AnalyticsService Performance', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: getRepositoryToken(Repo),
          useValue: {
            find: jest.fn().mockResolvedValue([
              { id: 'r1', fullName: 'org/repo', language: 'TypeScript', fileCount: 120, isActive: true },
            ]),
          },
        },
        {
          provide: getRepositoryToken(PrReview),
          useValue: {
            find: jest.fn().mockResolvedValue([
              { id: 'p1', repo: 'org/repo', prNumber: 1, status: 'completed', findings: { score: 90 }, createdAt: new Date() },
            ]),
          },
        },
        {
          provide: getRepositoryToken(WebhookEvent),
          useValue: {
            find: jest.fn().mockResolvedValue([
              { id: 'w1', eventType: 'push', action: 'synchronize', repo: 'org/repo', processed: true, error: null, createdAt: new Date() },
            ]),
          },
        },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockImplementation((sql: string) => {
              if (sql.includes('COUNT(*)::int           AS total_chunks')) {
                return Promise.resolve([{ total_chunks: 500, total_files: 80 }]);
              }
              if (sql.includes('GROUP BY cc.repo_id, r.full_name')) {
                return Promise.resolve([{ repo_id: 'r1', full_name: 'org/repo', chunk_count: 500 }]);
              }
              if (sql.includes('WITH date_series')) {
                return Promise.resolve([{ date: '2026-03-16', chats: 10, searches: 20, users: 2 }]);
              }
              if (sql.includes('LEFT JOIN (') && sql.includes('context_artifacts')) {
                return Promise.resolve([{ name: 'org/repo', chunks: 500, artifacts: 10, last_sync: new Date().toISOString() }]);
              }
              if (sql.includes('COUNT(*) FILTER')) {
                return Promise.resolve([{ total_chats: 100, total_searches: 300 }]);
              }
              if (sql.includes('FROM context_artifacts')) {
                return Promise.resolve([{ total_artifacts: 22 }]);
              }
              if (sql.includes('COUNT(DISTINCT user_id)')) {
                return Promise.resolve([{ active_users: 4 }]);
              }
              if (sql.includes('FROM chat_sessions')) {
                return Promise.resolve([{ id: 's1', title: 'Session', updated_at: new Date().toISOString() }]);
              }
              if (sql.includes('FROM chat_messages')) {
                return Promise.resolve([{ query: 'auth flow', frequency: 12 }]);
              }
              return Promise.resolve([]);
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  it('builds dashboard snapshot under baseline threshold', async () => {
    const start = Date.now();
    await service.getDashboardSnapshot('7d');
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1500);
  });
});
