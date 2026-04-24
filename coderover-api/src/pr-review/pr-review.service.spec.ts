import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PrReviewService } from './pr-review.service';
import { PrReview } from '../entities/pr-review.entity';
import { PrReviewFinding } from '../entities/pr-review-finding.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';
import { Repo } from '../entities/repo.entity';
import { GitHubService } from '../ingest/github.service';
import { MemgraphService } from '../graph/memgraph.service';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';
import { SearchService } from '../search/search.service';

const mockRepo = (overrides: any = {}) => ({
  create: jest.fn().mockImplementation((v: any) => v),
  save: jest.fn().mockImplementation((v: any) => Promise.resolve({ id: 'uuid-1', ...v })),
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  ...overrides,
});

describe('PrReviewService', () => {
  let service: PrReviewService;
  let prReviewRepo: any;
  let webhookRepo: any;
  let githubService: any;

  beforeEach(async () => {
    prReviewRepo = mockRepo();
    webhookRepo = mockRepo();

    githubService = {
      parseRepo: jest.fn().mockImplementation((repo: string) => {
        const [owner, name] = repo.split('/');
        return { owner, repo: name };
      }),
      getPrInfo: jest.fn().mockResolvedValue({
        number: 42,
        title: 'Add payment service',
        body: 'Implements PaymentService',
        headSha: 'abc123',
        baseSha: 'def456',
        headBranch: 'feat/payment',
        baseBranch: 'main',
        author: 'devuser',
        url: 'https://github.com/org/repo/pull/42',
        state: 'open',
      }),
      getPrFiles: jest.fn().mockResolvedValue([
        {
          filename: 'src/payment/payment.service.ts',
          status: 'added',
          additions: 80,
          deletions: 0,
          changes: 80,
          patch: '@@ -0,0 +1,80 @@\n+export class PaymentService {}',
        },
      ]),
      getPrCommits: jest.fn().mockResolvedValue([
        {
          sha: 'abc123',
          message: 'feat: add payment service',
          author: 'devuser',
          date: new Date().toISOString(),
        },
      ]),
      getRelatedIssuesAndPrs: jest.fn().mockResolvedValue([
        {
          number: 12,
          type: 'issue',
          title: 'Improve payment retries',
          state: 'open',
          url: 'https://github.com/org/repo/issues/12',
        },
      ]),
      getRepositoryStructure: jest.fn().mockResolvedValue([
        'src/payment/payment.service.ts',
        'src/payment/payment.controller.ts',
      ]),
      postPrReviewComment: jest.fn().mockResolvedValue({
        commentId: 999,
        url: 'https://github.com/org/repo/issues/42#comment-999',
      }),
      verifyWebhookSignature: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrReviewService,
        { provide: getRepositoryToken(PrReview), useValue: prReviewRepo },
        { provide: getRepositoryToken(WebhookEvent), useValue: webhookRepo },
        { provide: getRepositoryToken(Repo), useValue: mockRepo() },
        { provide: getRepositoryToken(PrReviewFinding), useValue: mockRepo() },
        { provide: GitHubService, useValue: githubService },
        { provide: DataSource, useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: MemgraphService, useValue: { readQuery: jest.fn().mockResolvedValue([]) } },
        ConfidenceTaggerService,
        SearchService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const cfg: Record<string, string> = {
                OPENAI_API_KEY: 'test-key',
                LLM_PROVIDER: 'openai',
                OPENAI_CHAT_MODEL: 'gpt-4o-mini',
                OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
              };
              return cfg[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PrReviewService>(PrReviewService);
  });

  describe('logWebhookEvent', () => {
    it('should create and save a webhook event', async () => {
      const payload = {
        repository: { full_name: 'org/repo' },
        ref: 'refs/heads/main',
        after: 'abc123',
        sender: { login: 'devuser' },
      };

      const result = await service.logWebhookEvent('push', payload);
      expect(webhookRepo.create).toHaveBeenCalled();
      expect(webhookRepo.save).toHaveBeenCalled();
      expect(result.eventType).toBe('push');
    });
  });

  describe('markEventProcessed', () => {
    it('should update processed=true when no error', async () => {
      await service.markEventProcessed('event-uuid');
      expect(webhookRepo.update).toHaveBeenCalledWith('event-uuid', {
        processed: true,
        error: null,
      });
    });

    it('should update processed=false with error message when error provided', async () => {
      await service.markEventProcessed('event-uuid', 'something went wrong');
      expect(webhookRepo.update).toHaveBeenCalledWith('event-uuid', {
        processed: false,
        error: 'something went wrong',
      });
    });
  });

  describe('reviewPullRequest', () => {
    it('should complete a review and return structured result', async () => {
      const result = await service.reviewPullRequest('org/repo', 42, { postComment: false });

      expect(githubService.getPrInfo).toHaveBeenCalledWith('org/repo', 42, undefined);
      expect(githubService.getPrFiles).toHaveBeenCalledWith('org/repo', 42, undefined);
      expect(githubService.getPrCommits).toHaveBeenCalledWith('org/repo', 42, undefined);
      expect(result.prNumber).toBe(42);
      expect(result.repo).toBe('org/repo');
      expect(typeof result.summary).toBe('string');
      expect(Array.isArray(result.findings)).toBe(true);
    });

    it('should throw NotFoundException when PR is not found on GitHub', async () => {
      githubService.getPrInfo.mockRejectedValueOnce({
        status: 404,
        message: 'Not Found - https://docs.github.com/rest/pulls/pulls#get-a-pull-request',
      });

      await expect(service.reviewPullRequest('org/repo', 42, { postComment: false })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should include deterministic dependency and security checks', async () => {
      githubService.getPrFiles.mockResolvedValueOnce([
        {
          filename: 'package.json',
          status: 'modified',
          additions: 8,
          deletions: 2,
          changes: 10,
          patch: '@@ -1,3 +1,5 @@\n+"left-pad": "1.3.0"\n+"API_KEY":"value"',
        },
      ]);

      const result = await service.reviewPullRequest('org/repo', 42, { postComment: false });
      expect(result.findings.some((item) => item.category === 'security')).toBe(true);
      expect(result.findings.some((item) => item.message.toLowerCase().includes('dependency'))).toBe(true);
    });

    it('should post comment when postComment=true', async () => {
      await service.reviewPullRequest('org/repo', 42, { postComment: true });
      expect(githubService.postPrReviewComment).toHaveBeenCalled();
    });

    it('should not post comment when postComment=false', async () => {
      await service.reviewPullRequest('org/repo', 42, { postComment: false });
      expect(githubService.postPrReviewComment).not.toHaveBeenCalled();
    });
  });

  describe('listReviews', () => {
    it('should return recent reviews', async () => {
      prReviewRepo.find.mockResolvedValue([
        { id: '1', repo: 'org/repo', prNumber: 1, status: 'completed' },
      ]);
      const result = await service.listReviews(10);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
