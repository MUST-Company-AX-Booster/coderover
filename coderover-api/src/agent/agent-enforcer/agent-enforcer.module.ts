import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentEnforcerService } from './agent-enforcer.service';
import { AgentEnforcerController } from './agent-enforcer.controller';
import { AgentRule } from '../../entities/agent-rule.entity';
import { CodeChunk } from '../../entities/code-chunk.entity';
import { AgentModule } from '../agent.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgentRule, CodeChunk]),
    AgentModule,
    AgentMemoryModule,
  ],
  controllers: [AgentEnforcerController],
  providers: [AgentEnforcerService],
  exports: [AgentEnforcerService],
})
export class AgentEnforcerModule {}
