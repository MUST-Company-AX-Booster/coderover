import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { AgentPrService } from './agent-pr.service';
import { AgentTrigger } from '../../entities/agent-run.entity';

@Processor('agent-pr-review')
export class AgentPrProcessor {
  private readonly logger = new Logger(AgentPrProcessor.name);

  constructor(private readonly agentPrService: AgentPrService) {}

  @Process('review')
  async handleReview(job: Job<{ repoId: string; repoFullName: string; prNumber: number; trigger: AgentTrigger }>) {
    this.logger.log(`Processing PR review job ${job.id} for ${job.data.repoFullName}#${job.data.prNumber}`);
    
    try {
      await this.agentPrService.runPrReview(
        job.data.repoId,
        job.data.repoFullName,
        job.data.prNumber,
        job.data.trigger,
      );
    } catch (err) {
      this.logger.error(`Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
