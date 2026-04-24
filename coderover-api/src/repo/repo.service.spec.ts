import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { RepoService } from './repo.service';
import { Repo } from '../entities/repo.entity';
import { GitHubService } from '../ingest/github.service';
import { SyncLog } from '../entities/sync-log.entity';
import { CodeChunk } from '../entities/code-chunk.entity';
import { MemgraphService } from '../graph/memgraph.service';

describe('RepoService', () => {
  let service: RepoService;
  let repoRepository: any;
  let githubService: any;
  let syncLogRepository: any;
  let codeChunkRepository: any;
  let memgraphService: any;

  const mockRepo: Partial<Repo> = {
    id: 'repo-uuid-1',
    owner: 'myorg',
    name: 'myrepo',
    fullName: 'myorg/myrepo',
    githubToken: null as any,
    branch: 'main',
    label: null as any,
    language: 'TypeScript',
    fileCount: 42,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    repoRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((data: any) => ({ ...data, id: 'repo-uuid-1' })),
      save: jest.fn().mockImplementation((entity: any) => Promise.resolve({ ...mockRepo, ...entity })),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    syncLogRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    };

    codeChunkRepository = {
      find: jest.fn(),
      delete: jest.fn(),
    };

    memgraphService = {
      query: jest.fn(),
      clearRepoData: jest.fn(),
      getSession: jest.fn().mockReturnValue({
        executeWrite: jest.fn(),
        close: jest.fn(),
      }),
    };

    githubService = {
      detectRepoInfo: jest.fn().mockResolvedValue({
        defaultBranch: 'main',
        language: 'TypeScript',
        fileCount: 42,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RepoService,
        { provide: getRepositoryToken(Repo), useValue: repoRepository },
        { provide: getRepositoryToken(SyncLog), useValue: syncLogRepository },
        { provide: getRepositoryToken(CodeChunk), useValue: codeChunkRepository },
        { provide: GitHubService, useValue: githubService },
        { provide: MemgraphService, useValue: memgraphService },
      ],
    }).compile();

    service = module.get<RepoService>(RepoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('register', () => {
    it('should register a new repo from owner/name format', async () => {
      repoRepository.findOne.mockResolvedValue(null);

      const result = await service.register({ repoUrl: 'myorg/myrepo' });

      expect(githubService.detectRepoInfo).toHaveBeenCalledWith('myorg/myrepo', undefined);
      expect(repoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'myorg', name: 'myrepo', fullName: 'myorg/myrepo' }),
      );
      expect(result.fullName).toBe('myorg/myrepo');
    });

    it('should parse full GitHub URL', async () => {
      repoRepository.findOne.mockResolvedValue(null);

      await service.register({ repoUrl: 'https://github.com/myorg/myrepo.git' });

      expect(githubService.detectRepoInfo).toHaveBeenCalledWith('myorg/myrepo', undefined);
    });

    it('should handle trailing slashes in repo URL', async () => {
      repoRepository.findOne.mockResolvedValue(null);

      const result = await service.register({ repoUrl: 'myorg/myrepo/' });

      expect(githubService.detectRepoInfo).toHaveBeenCalledWith('myorg/myrepo', undefined);
      expect(result.fullName).toBe('myorg/myrepo');
    });

    it('should throw ConflictException if repo already exists', async () => {
      repoRepository.findOne.mockResolvedValue(mockRepo);

      await expect(service.register({ repoUrl: 'myorg/myrepo' })).rejects.toThrow(ConflictException);
    });

    it('should pass githubToken to detectRepoInfo', async () => {
      repoRepository.findOne.mockResolvedValue(null);

      await service.register({ repoUrl: 'myorg/myrepo', githubToken: 'ghp_secret' });

      expect(githubService.detectRepoInfo).toHaveBeenCalledWith('myorg/myrepo', 'ghp_secret');
    });

    it('should reactivate inactive repo without overwriting branch when branch is omitted', async () => {
      const inactive = { ...mockRepo, isActive: false, branch: 'master' };
      repoRepository.findOne
        .mockResolvedValueOnce(inactive)
        .mockResolvedValueOnce(inactive);

      const result = await service.register({ repoUrl: 'myorg/myrepo' });

      expect(repoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true, branch: 'master' }),
      );
      expect(result.branch).toBe('master');
    });
  });

  describe('findById', () => {
    it('should return repo when found', async () => {
      repoRepository.findOne.mockResolvedValue(mockRepo);

      const result = await service.findById('repo-uuid-1');
      expect(result).toEqual(mockRepo);
    });

    it('should throw NotFoundException when not found', async () => {
      repoRepository.findOne.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should return active repos', async () => {
      repoRepository.find.mockResolvedValue([mockRepo]);

      const result = await service.findAll();
      expect(result).toEqual([mockRepo]);
      expect(repoRepository.find).toHaveBeenCalledWith({ where: { isActive: true } });
    });
  });

  describe('deactivate', () => {
    it('should set isActive to false', async () => {
      repoRepository.findOne.mockResolvedValue({ ...mockRepo, isActive: true });

      await service.deactivate('repo-uuid-1');

      expect(repoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: false }),
      );
    });
  });

  describe('delete', () => {
    it('should remove the repo entity', async () => {
      repoRepository.findOne.mockResolvedValue(mockRepo);

      await service.delete('repo-uuid-1');

      expect(repoRepository.remove).toHaveBeenCalledWith(mockRepo);
    });
  });

  describe('buildSystemPrompt', () => {
    it('should return generic prompt when no repoIds', async () => {
      const prompt = await service.buildSystemPrompt([]);
      expect(prompt).toContain('AI code assistant');
    });

    it('should return single-repo prompt for one repoId', async () => {
      repoRepository.findOne.mockResolvedValue(mockRepo);

      const prompt = await service.buildSystemPrompt(['repo-uuid-1']);
      expect(prompt).toContain('myorg/myrepo');
      expect(prompt).toContain('TypeScript');
    });

    it('should return multi-repo prompt for multiple repoIds', async () => {
      const repo2 = { ...mockRepo, id: 'repo-uuid-2', fullName: 'myorg/other-repo', language: 'Go' };
      repoRepository.findOne
        .mockResolvedValueOnce(mockRepo)
        .mockResolvedValueOnce(repo2);

      const prompt = await service.buildSystemPrompt(['repo-uuid-1', 'repo-uuid-2']);
      expect(prompt).toContain('2 indexed codebases');
      expect(prompt).toContain('cross-repo');
    });
  });
});
