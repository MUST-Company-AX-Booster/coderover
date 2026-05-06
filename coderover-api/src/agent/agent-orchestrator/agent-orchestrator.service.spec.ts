import { Test, TestingModule } from '@nestjs/testing';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentApprovalService } from '../agent-approval/agent-approval.service';
import { AgentRefactorService } from '../agent-refactor/agent-refactor.service';
import { EventsService } from '../../events/events.service';

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
        // EventsService dependency added without spec update. The
        // real service exposes `publish(room, event, payload)` and
        // `publishMany(rooms, event, payload)` — NOT `emit`. Stubbing
        // the wrong name would crash any test that triggered an event.
        { provide: EventsService, useValue: { publish: jest.fn(), publishMany: jest.fn() } },
      ],
    }).compile();

    service = module.get<AgentOrchestratorService>(AgentOrchestratorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
