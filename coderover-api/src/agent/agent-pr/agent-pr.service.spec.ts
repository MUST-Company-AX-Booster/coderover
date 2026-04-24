import { Test, TestingModule } from '@nestjs/testing';
import { AgentPrService } from './agent-pr.service';
import { AgentService } from '../agent.service';
import { PrReviewService } from '../../pr-review/pr-review.service';
import { GitHubService } from '../../ingest/github.service';
import { AgentType, AgentTrigger } from '../../entities/agent-run.entity';

const mockAgentService = {
  startRun: jest.fn(),
  completeRun: jest.fn(),
  failRun: jest.fn(),
};

const mockPrReviewService = {
  reviewPullRequest: jest.fn(),
};

const mockGitHubService = {
  createPrReview: jest.fn(),
};

describe('AgentPrService', () => {
  let service: AgentPrService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentPrService,
        { provide: AgentService, useValue: mockAgentService },
        { provide: PrReviewService, useValue: mockPrReviewService },
        { provide: GitHubService, useValue: mockGitHubService },
      ],
    }).compile();

    service = module.get<AgentPrService>(AgentPrService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should run PR review', async () => {
    mockAgentService.startRun.mockResolvedValue({ id: 'run-1' });
    mockPrReviewService.reviewPullRequest.mockResolvedValue({
      findings: [],
      score: 100,
      recommendation: 'approve',
      summary: 'LGTM',
    });
    mockGitHubService.createPrReview.mockResolvedValue({ url: 'http://pr/review/1' });
    mockAgentService.completeRun.mockResolvedValue({});

    await service.runPrReview('repo-1', 'owner/repo', 1, AgentTrigger.WEBHOOK);

    expect(mockAgentService.startRun).toHaveBeenCalledWith('repo-1', AgentType.PR_REVIEW, AgentTrigger.WEBHOOK, expect.anything());
    expect(mockPrReviewService.reviewPullRequest).toHaveBeenCalledWith('owner/repo', 1, { postComment: false, repoId: 'repo-1' });
    expect(mockGitHubService.createPrReview).toHaveBeenCalledWith('owner/repo', 1, expect.stringContaining('Score: 100'), 'APPROVE');
    expect(mockAgentService.completeRun).toHaveBeenCalledWith('run-1', 0, 0);
  });
});
