import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { AgentMemory, AgentMemoryType } from '../../entities/agent-memory.entity';

@Injectable()
export class AgentMemoryService {
  constructor(
    @InjectRepository(AgentMemory)
    private memoryRepo: Repository<AgentMemory>,
  ) {}

  async createMemory(
    repoId: string,
    type: AgentMemoryType,
    key: string,
    value: Record<string, any>,
    ttlDays?: number,
  ): Promise<AgentMemory> {
    const expiresAt = ttlDays
      ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
      : undefined;

    const memory = this.memoryRepo.create({
      repoId,
      memoryType: type,
      key,
      value,
      expiresAt,
    });

    return this.memoryRepo.save(memory);
  }

  async getMemory(
    repoId: string,
    type: AgentMemoryType,
    key: string,
  ): Promise<AgentMemory | null> {
    return this.memoryRepo.findOne({
      where: {
        repoId,
        memoryType: type,
        key,
      },
    });
  }

  async listMemory(
    repoId: string,
    type?: AgentMemoryType,
  ): Promise<AgentMemory[]> {
    const where: any = { repoId };
    if (type) {
      where.memoryType = type;
    }
    return this.memoryRepo.find({ where });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.memoryRepo.delete(id);
  }

  async cleanupExpiredMemory(): Promise<void> {
    await this.memoryRepo.delete({
      expiresAt: LessThan(new Date()),
    });
  }
}
