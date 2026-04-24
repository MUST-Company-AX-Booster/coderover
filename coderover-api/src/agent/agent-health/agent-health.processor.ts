import { Process, Processor } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { AgentHealthService } from './agent-health.service';
import { RepoService } from '../../repo/repo.service';
import { AgentTrigger } from '../../entities/agent-run.entity';
import { ConfigService } from '@nestjs/config';

@Processor('agent-health')
export class AgentHealthProcessor implements OnModuleInit {
  private readonly logger = new Logger(AgentHealthProcessor.name);

  constructor(
    private readonly healthService: AgentHealthService,
    private readonly repoService: RepoService,
    private readonly configService: ConfigService,
    @InjectQueue('agent-health') private readonly healthQueue: Queue,
  ) {}

  async onModuleInit() {
    const cronSchedule = this.configService.get<string>('AGENT_HEALTH_CRON', '0 2 * * 0'); // Weekly Sunday 2am
    
    await this.healthQueue.add('master-cron', {}, {
      repeat: { cron: cronSchedule },
      jobId: 'agent-health-master-cron',
      removeOnComplete: true,
    });
    
    this.logger.log(`Scheduled agent-health master cron: ${cronSchedule}`);
  }

  @Process('master-cron')
  async handleMasterCron(_job: Job) {
    void _job;
    this.logger.log('Running agent-health master cron');
    const repos = await this.repoService.findAll();
    
    for (const repo of repos) {
       await this.healthQueue.add('check-repo', { repoId: repo.id }, {
           removeOnComplete: true,
       });
    }
  }

  @Process('check-repo')
  async handleCheckRepo(job: Job<{ repoId: string }>) {
      this.logger.log(`Processing health check for repo ${job.data.repoId}`);
      await this.healthService.generateReport(job.data.repoId, AgentTrigger.CRON);
  }
}
