import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentEnforcerService } from './agent-enforcer.service';
import { AgentRule } from '../../entities/agent-rule.entity';
import { CodeChunk } from '../../entities/code-chunk.entity';
import { AgentService } from '../agent.service';

const mockRuleRepo = {
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
};

const mockChunkRepo = {
  createQueryBuilder: jest.fn(),
};

const mockAgentService = {
  startRun: jest.fn(),
  completeRun: jest.fn(),
  failRun: jest.fn(),
};

describe('AgentEnforcerService', () => {
  let service: AgentEnforcerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentEnforcerService,
        { provide: getRepositoryToken(AgentRule), useValue: mockRuleRepo },
        { provide: getRepositoryToken(CodeChunk), useValue: mockChunkRepo },
        { provide: AgentService, useValue: mockAgentService },
      ],
    }).compile();

    service = module.get<AgentEnforcerService>(AgentEnforcerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
