import { Test, TestingModule } from '@nestjs/testing';
import { AgentHealthService } from './agent-health.service';
import { AgentService } from '../agent.service';
import { AgentRefactorService } from '../agent-refactor/agent-refactor.service';
import { AgentEnforcerService } from '../agent-enforcer/agent-enforcer.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { GraphService } from '../../graph/graph.service';

const mockAgentService = {
  startRun: jest.fn(),
  completeRun: jest.fn(),
  failRun: jest.fn(),
};

const mockRefactorService = {
  scanRepo: jest.fn(),
};

const mockEnforcerService = {
  enforceRules: jest.fn(),
};

const mockAnalyticsService = {
  getRepoAnalytics: jest.fn(),
};

const mockGraphService = {
  buildGraph: jest.fn(),
};

describe('AgentHealthService', () => {
  let service: AgentHealthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentHealthService,
        { provide: AgentService, useValue: mockAgentService },
        { provide: AgentRefactorService, useValue: mockRefactorService },
        { provide: AgentEnforcerService, useValue: mockEnforcerService },
        { provide: AnalyticsService, useValue: mockAnalyticsService },
        { provide: GraphService, useValue: mockGraphService },
      ],
    }).compile();

    service = module.get<AgentHealthService>(AgentHealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
