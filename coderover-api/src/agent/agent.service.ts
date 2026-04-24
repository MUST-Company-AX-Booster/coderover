import { Injectable, Logger, HttpException, HttpStatus, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { AgentRun, AgentRunStatus, AgentType, AgentTrigger } from '../entities/agent-run.entity';
import { SystemSetting } from '../entities/system-setting.entity';
import { currentOrgId } from '../organizations/org-context';
import { MetricsService } from '../observability/metrics.service';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @InjectRepository(AgentRun)
    private agentRunRepo: Repository<AgentRun>,
    @InjectRepository(SystemSetting)
    private settingRepo: Repository<SystemSetting>,
    private metrics: MetricsService,
  ) {}

  async startRun(
    repoId: string,
    agentType: AgentType,
    trigger: AgentTrigger,
    metadata: Record<string, any> = {},
  ): Promise<AgentRun> {
    // Rate check
    const maxRuns = await this.getMaxRunsPerHour();

    if (maxRuns === 0) {
      const run = this.agentRunRepo.create({
        repoId,
        agentType,
        trigger,
        status: AgentRunStatus.RUNNING,
        startedAt: new Date(),
        metadata,
        orgId: currentOrgId() ?? null,
      });

      return this.agentRunRepo.save(run);
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentRuns = await this.agentRunRepo.count({
      where: {
        repoId,
        agentType,
        startedAt: MoreThan(oneHourAgo),
      },
    });

    if (recentRuns >= maxRuns) {
      throw new HttpException(
        `Rate limit exceeded: Max ${maxRuns} runs per hour for ${agentType}`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const run = this.agentRunRepo.create({
      repoId,
      agentType,
      trigger,
      status: AgentRunStatus.RUNNING,
      startedAt: new Date(),
      metadata,
    });

    return this.agentRunRepo.save(run);
  }

  async completeRun(
    runId: string,
    findingsCount: number,
    tokensUsed: number,
    metadata?: Record<string, any>,
  ): Promise<AgentRun> {
    const run = await this.agentRunRepo.findOne({ where: { id: runId } });
    if (!run) throw new Error('Run not found');

    run.status = AgentRunStatus.COMPLETED;
    run.completedAt = new Date();
    run.findingsCount = findingsCount;
    run.llmTokensUsed = tokensUsed;
    if (metadata) {
      run.metadata = { ...run.metadata, ...metadata };
    }

    return this.agentRunRepo.save(run);
  }

  async failRun(runId: string, error: string): Promise<AgentRun> {
    const run = await this.agentRunRepo.findOne({ where: { id: runId } });
    if (!run) throw new Error('Run not found');

    run.status = AgentRunStatus.FAILED;
    run.completedAt = new Date();
    run.errorMessage = error;

    return this.agentRunRepo.save(run);
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    return this.agentRunRepo.findOne({ where: { id: runId } });
  }

  async listRuns(repoId: string, limit = 20, type?: AgentType): Promise<AgentRun[]> {
    // Security fix 2026-04-15: fail closed when orgId is missing.
    const orgId = currentOrgId();
    if (!orgId) throw new ForbiddenException('Organization scope required');
    const where: any = { repoId, orgId };
    if (type) where.agentType = type;

    return this.agentRunRepo.find({
      where,
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }

  async getStatus(): Promise<any> {
    const activeRuns = await this.agentRunRepo.count({ where: { status: AgentRunStatus.RUNNING } });
    const queued = await this.agentRunRepo.count({ where: { status: AgentRunStatus.QUEUED } });
    // Phase 9: update gauge each time status is queried (also hit by healthcheck).
    try {
      this.metrics.set('coderover_agent_runs_active', activeRuns);
      this.metrics.set('coderover_agent_runs_queued', queued);
    } catch { /* best-effort */ }
    return { activeRuns, queued };
  }

  private async getMaxRunsPerHour(): Promise<number> {
    const row = await this.settingRepo.findOne({ where: { key: 'AGENT_MAX_RUNS_PER_HOUR' } });
    const raw = row?.value;

    if (raw === null || raw === undefined) return 3;
    if (typeof raw === 'number') return this.sanitizeMaxRuns(raw);
    if (typeof raw === 'string') return this.sanitizeMaxRuns(Number(raw));
    if (typeof raw === 'boolean') return this.sanitizeMaxRuns(raw ? 1 : 0);
    return 3;
  }

  private sanitizeMaxRuns(value: number): number {
    if (!Number.isFinite(value) || value < 0) return 3;
    return value;
  }
}
