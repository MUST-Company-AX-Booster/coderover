import { Injectable, Logger } from '@nestjs/common';
import { AgentService } from '../agent.service';
import { AgentRefactorService } from '../agent-refactor/agent-refactor.service';
import { AgentEnforcerService } from '../agent-enforcer/agent-enforcer.service';
import { AnalyticsService } from '../../analytics/analytics.service';
import { GraphService } from '../../graph/graph.service';
import { AgentType, AgentTrigger } from '../../entities/agent-run.entity';

@Injectable()
export class AgentHealthService {
  private readonly logger = new Logger(AgentHealthService.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly refactorService: AgentRefactorService,
    private readonly enforcerService: AgentEnforcerService,
    private readonly analyticsService: AnalyticsService,
    private readonly graphService: GraphService,
  ) {}

  async generateReport(repoId: string, trigger: AgentTrigger = AgentTrigger.CRON): Promise<any> {
    const run = await this.agentService.startRun(repoId, AgentType.HEALTH_CHECK, trigger);

    try {
      // 1. Refactor Scan
      const codeSmells = await this.refactorService.scanRepo(repoId, AgentTrigger.MANUAL);

      // 2. Enforcer Scan
      const violations = await this.enforcerService.enforceRules(repoId, AgentTrigger.MANUAL);

      // 3. Analytics
      const stats = await this.analyticsService.getRepoAnalytics(repoId);

      // 4. Graph Analysis
      const graphData = await this.graphService.buildGraph(repoId);

      const report = {
        generatedAt: new Date(),
        repoId,
        codeSmells: {
          count: codeSmells.length,
          top: codeSmells.slice(0, 10),
        },
        violations: {
          count: violations.length,
          top: violations.slice(0, 10),
        },
        analytics: stats,
        graph: {
          cyclesCount: graphData.cycles.length,
          hotspotsCount: graphData.hotspots.length,
          cycles: graphData.cycles.slice(0, 5), // Include top 5 cycles
          hotspots: graphData.hotspots.slice(0, 5),
        },
      };

      await this.agentService.completeRun(run.id, codeSmells.length + violations.length, 0, { report });
      return report;
    } catch (err) {
      await this.agentService.failRun(run.id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
