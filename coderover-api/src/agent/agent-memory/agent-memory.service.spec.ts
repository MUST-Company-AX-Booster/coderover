import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentMemoryService } from './agent-memory.service';
import { AgentMemory, AgentMemoryType } from '../../entities/agent-memory.entity';

const mockMemoryRepo = {
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  delete: jest.fn(),
};

describe('AgentMemoryService', () => {
  let service: AgentMemoryService;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentMemoryService,
        {
          provide: getRepositoryToken(AgentMemory),
          useValue: mockMemoryRepo,
        },
      ],
    }).compile();

    service = module.get<AgentMemoryService>(AgentMemoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create memory', async () => {
    const dto = {
      repoId: 'repo-1',
      type: AgentMemoryType.PREFERENCE,
      key: 'indent',
      value: { size: 4 },
    };
    mockMemoryRepo.create.mockReturnValue(dto);
    mockMemoryRepo.save.mockResolvedValue({ id: 'mem-1', ...dto });

    const result = await service.createMemory(dto.repoId, dto.type, dto.key, dto.value);
    expect(result).toEqual(expect.objectContaining({ id: 'mem-1' }));
    expect(mockMemoryRepo.create).toHaveBeenCalled();
    expect(mockMemoryRepo.save).toHaveBeenCalled();
  });

  it('should get memory', async () => {
    const mem = { id: 'mem-1', key: 'indent' };
    mockMemoryRepo.findOne.mockResolvedValue(mem);

    const result = await service.getMemory('repo-1', AgentMemoryType.PREFERENCE, 'indent');
    expect(result).toEqual(mem);
    expect(mockMemoryRepo.findOne).toHaveBeenCalledWith({
      where: { repoId: 'repo-1', memoryType: AgentMemoryType.PREFERENCE, key: 'indent' },
    });
  });

  it('should list memory', async () => {
    const mems = [{ id: 'mem-1' }, { id: 'mem-2' }];
    mockMemoryRepo.find.mockResolvedValue(mems);

    const result = await service.listMemory('repo-1');
    expect(result).toEqual(mems);
    expect(mockMemoryRepo.find).toHaveBeenCalledWith({ where: { repoId: 'repo-1' } });
  });

  it('should delete memory', async () => {
    mockMemoryRepo.delete.mockResolvedValue({ affected: 1 });
    await service.deleteMemory('mem-1');
    expect(mockMemoryRepo.delete).toHaveBeenCalledWith('mem-1');
  });
});
