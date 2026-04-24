import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentMemory } from '../../entities/agent-memory.entity';
import { AgentMemoryService } from './agent-memory.service';
import { AgentMemoryController } from './agent-memory.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AgentMemory])],
  controllers: [AgentMemoryController],
  providers: [AgentMemoryService],
  exports: [AgentMemoryService],
})
export class AgentMemoryModule {}
