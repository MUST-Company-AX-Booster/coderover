import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PrReviewService } from './pr-review.service';
import { PrReview } from '../entities/pr-review.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';
import { Repo } from '../entities/repo.entity';
import { GitHubService } from '../ingest/github.service';
import { MemgraphService } from '../graph/memgraph.service';
import { SearchService } from '../search/search.service';

describe('PrReviewService Performance', () => {
  let service: PrReviewService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrReviewService,
        {
          provide: getRepositoryToken(PrReview),
          useValue: {
            create: jest.fn().mockImplementation((v: any) => v),
            save: jest.fn().mockImplementation((v: any) => Promise.resolve({ id: 'uuid-1', ...v })),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(WebhookEvent),
          useValue: {
            create: jest.fn().mockImplementation((v: any) => v),
            save: jest.fn().mockImplementation((v: any) => Promise.resolve({ id: 'evt-1', ...v })),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            find: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: getRepositoryToken(Repo),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: GitHubService,
          useValue: {
            parseRepo: jest.fn().mockImplementation((repo: string) => {
              const [owner, name] = repo.split('/');
              return { owner, repo: name };
            }),
            getPrInfo: jest.fn().mockResolvedValue({
              number: 5,
              title: 'Improve auth guards',
              body: 'Closes #12',
              headSha: 'abc123',
              baseSha: 'def456',
              headBranch: 'feat/auth',
              baseBranch: 'main',
              author: 'devuser',
              url: 'https://github.com/org/repo/pull/5',
              state: 'open',
            }),
            getPrFiles: jest.fn().mockResolvedValue([
              {
                filename: 'src/auth/guard.ts',
                status: 'modified',
                additions: 40,
                deletions: 10,
                changes: 50,
                patch: '@@ -1,5 +1,10 @@\n+if (secret) {}',
              },
            ]),
            getPrCommits: jest.fn().mockResolvedValue([
              { sha: 'abc123', message: 'feat: auth hardening', author: 'dev', date: new Date().toISOString() },
            ]),
            getRelatedIssuesAndPrs: jest.fn().mockResolvedValue([]),
            getRepositoryStructure: jest.fn().mockResolvedValue(['src/auth/guard.ts']),
            postPrReviewComment: jest.fn().mockResolvedValue({ commentId: 1, url: 'https://example.com/comment/1' }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const cfg: Record<string, string> = {
                OPENAI_API_KEY: 'test-key',
                LLM_PROVIDER: 'local',
                OPENAI_CHAT_MODEL: 'gpt-4o-mini',
              };
              return cfg[key];
            }),
          },
        },
        {
          provide: DataSource,
          useValue: { query: jest.fn().mockResolvedValue([]) },
        },
        { provide: MemgraphService, useValue: { readQuery: jest.fn().mockResolvedValue([]) } },
        { provide: SearchService, useValue: { search: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    service = module.get<PrReviewService>(PrReviewService);
  });

  it('completes review pipeline under baseline threshold', async () => {
    const start = Date.now();
    await service.reviewPullRequest('org/repo', 5, { postComment: false });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(2500);
  });
});
