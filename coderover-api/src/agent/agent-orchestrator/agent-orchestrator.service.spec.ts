import { Test, TestingModule } from '@nestjs/testing';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentApprovalService } from '../agent-approval/agent-approval.service';
import { AgentRefactorService } from '../agent-refactor/agent-refactor.service';

const mockApprovalService = {
  getApproval: jest.fn(),
  getApprovalById: jest.fn(),
};

const mockRefactorService = {
  applyFix: jest.fn(),
};

describe('AgentOrchestratorService', () => {
  let service: AgentOrchestratorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentOrchestratorService,
        { provide: AgentApprovalService, useValue: mockApprovalService },
        { provide: AgentRefactorService, useValue: mockRefactorService },
      ],
    }).compile();

    service = module.get<AgentOrchestratorService>(AgentOrchestratorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
