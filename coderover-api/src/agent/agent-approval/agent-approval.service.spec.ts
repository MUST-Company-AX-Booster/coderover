import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentApprovalService } from './agent-approval.service';
import { AgentApproval } from '../../entities/agent-approval.entity';

const mockApprovalRepo = {
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
};

describe('AgentApprovalService', () => {
  let service: AgentApprovalService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentApprovalService,
        { provide: getRepositoryToken(AgentApproval), useValue: mockApprovalRepo },
      ],
    }).compile();

    service = module.get<AgentApprovalService>(AgentApprovalService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
