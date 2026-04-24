import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRun } from '../entities/agent-run.entity';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { SystemSetting } from '../entities/system-setting.entity';
import { ObservabilityModule } from '../observability/observability.module';

@Module({
  imports: [TypeOrmModule.forFeature([AgentRun, SystemSetting]), ObservabilityModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
