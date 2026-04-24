import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentRefactorService } from './agent-refactor.service';
import { CodeChunk } from '../../entities/code-chunk.entity';
import { CodeMethod } from '../../entities/code-method.entity';
import { Repo } from '../../entities/repo.entity';
import { AgentService } from '../agent.service';
import { AgentMemoryService } from '../agent-memory/agent-memory.service';
import { AgentApprovalService } from '../agent-approval/agent-approval.service';
import { GitHubService } from '../../ingest/github.service';
import { AdminConfigService } from '../../admin/admin-config.service';
import { DataSource } from 'typeorm';
import { MemgraphService } from '../../graph/memgraph.service';

const mockChunkRepo = {
  createQueryBuilder: jest.fn(),
  query: jest.fn(),
};

const mockMethodRepo = {
  createQueryBuilder: jest.fn(),
};

const mockRepoRepo = {
  findOne: jest.fn(),
};

const mockDataSource = {};
const mockAgentService = {
  startRun: jest.fn(),
  completeRun: jest.fn(),
  failRun: jest.fn(),
  listRuns: jest.fn(),
};
const mockMemoryService = {
  listMemory: jest.fn(),
};
const mockApprovalService = {
  createApproval: jest.fn(),
};
const mockGithubService = {
  getLatestCommitSha: jest.fn(),
  createBranch: jest.fn(),
  getFileContent: jest.fn(),
  createOrUpdateFile: jest.fn(),
  createPullRequest: jest.fn(),
};
const mockAdminConfigService = {
  getLlmConfig: jest.fn(),
  getSecret: jest.fn(),
};
const mockMemgraphService = {
  readQuery: jest.fn().mockResolvedValue([]),
};

describe('AgentRefactorService', () => {
  let service: AgentRefactorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRefactorService,
        { provide: getRepositoryToken(CodeChunk), useValue: mockChunkRepo },
        { provide: getRepositoryToken(CodeMethod), useValue: mockMethodRepo },
        { provide: getRepositoryToken(Repo), useValue: mockRepoRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: AgentService, useValue: mockAgentService },
        { provide: AgentMemoryService, useValue: mockMemoryService },
        { provide: AgentApprovalService, useValue: mockApprovalService },
        { provide: GitHubService, useValue: mockGithubService },
        { provide: AdminConfigService, useValue: mockAdminConfigService },
        { provide: MemgraphService, useValue: mockMemgraphService },
      ],
    }).compile();

    service = module.get<AgentRefactorService>(AgentRefactorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('applyFix creates branch, commits, opens PR, and completes run', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(123);

    mockRepoRepo.findOne.mockResolvedValue({
      id: 'repo1',
      fullName: 'owner/repo',
      branch: 'main',
      githubToken: 'token',
    });
    mockAgentService.listRuns.mockResolvedValue([]);
    mockGithubService.getLatestCommitSha.mockResolvedValue('sha123');
    mockGithubService.getFileContent.mockResolvedValue('old');
    mockGithubService.createBranch.mockResolvedValue(undefined);
    mockGithubService.createOrUpdateFile.mockResolvedValue({ path: 'file.ts', sha: 'filesha' });
    mockGithubService.createPullRequest.mockResolvedValue({ number: 7, url: 'https://github.com/owner/repo/pull/7' });

    (service as any).generateUpdatedFileContent = jest.fn().mockResolvedValue({ content: 'new', tokensUsed: 11 });

    const res = await service.applyFix({ repoId: 'repo1', suggestionId: 'file.ts|CS-01', runId: 'run1' });

    expect(mockGithubService.createBranch).toHaveBeenCalled();
    expect(mockGithubService.createOrUpdateFile).toHaveBeenCalled();
    expect(mockGithubService.createPullRequest).toHaveBeenCalled();
    expect(mockAgentService.completeRun).toHaveBeenCalledWith(
      'run1',
      1,
      11,
      expect.objectContaining({ prUrl: 'https://github.com/owner/repo/pull/7' }),
    );
    expect(res.prUrl).toBe('https://github.com/owner/repo/pull/7');
  });
});
