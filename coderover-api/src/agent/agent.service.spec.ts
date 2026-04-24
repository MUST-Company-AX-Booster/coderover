import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentService } from './agent.service';
import { AgentRun, AgentType, AgentTrigger } from '../entities/agent-run.entity';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SystemSetting } from '../entities/system-setting.entity';

const mockAgentRunRepo = {
  create: jest.fn(),
  save: jest.fn(),
  count: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
};

const mockSettingRepo = {
  findOne: jest.fn(),
};

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        {
          provide: getRepositoryToken(AgentRun),
          useValue: mockAgentRunRepo,
        },
        {
          provide: getRepositoryToken(SystemSetting),
          useValue: mockSettingRepo,
        },
      ],
    }).compile();

    service = module.get<AgentService>(AgentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should start run', async () => {
    mockSettingRepo.findOne.mockResolvedValue({ key: 'AGENT_MAX_RUNS_PER_HOUR', value: 3 });
    mockAgentRunRepo.count.mockResolvedValue(0);
    mockAgentRunRepo.create.mockReturnValue({ id: 'run-1' });
    mockAgentRunRepo.save.mockResolvedValue({ id: 'run-1' });

    const result = await service.startRun('repo-1', AgentType.PR_REVIEW, AgentTrigger.WEBHOOK);
    expect(result).toEqual({ id: 'run-1' });
    expect(mockAgentRunRepo.create).toHaveBeenCalled();
  });

  it('should enforce rate limit', async () => {
    mockSettingRepo.findOne.mockResolvedValue({ key: 'AGENT_MAX_RUNS_PER_HOUR', value: 3 });
    mockAgentRunRepo.count.mockResolvedValue(3);

    try {
      await service.startRun('repo-1', AgentType.PR_REVIEW, AgentTrigger.WEBHOOK);
      throw new Error('Expected rate limit exception');
    } catch (err) {
      if (err instanceof Error && err.message === 'Expected rate limit exception') throw err;
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });
});
