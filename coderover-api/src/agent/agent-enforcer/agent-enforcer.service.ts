import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRule, AgentRuleSeverity } from '../../entities/agent-rule.entity';
import { CodeChunk } from '../../entities/code-chunk.entity';
import { AgentService } from '../agent.service';
import { AgentType, AgentTrigger } from '../../entities/agent-run.entity';

export interface EnforcerViolation {
  ruleId: string;
  name: string;
  severity: AgentRuleSeverity;
  file: string;
  line: number;
  message: string;
}

@Injectable()
export class AgentEnforcerService {
  private readonly logger = new Logger(AgentEnforcerService.name);

  constructor(
    @InjectRepository(AgentRule)
    private ruleRepo: Repository<AgentRule>,
    @InjectRepository(CodeChunk)
    private chunkRepo: Repository<CodeChunk>,
    private agentService: AgentService,
  ) {}

  async enforceRules(repoId: string, trigger: AgentTrigger = AgentTrigger.MANUAL): Promise<EnforcerViolation[]> {
    const run = await this.agentService.startRun(repoId, AgentType.ENFORCER, trigger);
    const violations: EnforcerViolation[] = [];

    try {
      // 1. Built-in Rules
      violations.push(...await this.checkBuiltInRules(repoId));

      // 2. Custom Rules
      violations.push(...await this.checkCustomRules(repoId));

      await this.agentService.completeRun(run.id, violations.length, 0, { violations });
      return violations;
    } catch (err) {
      await this.agentService.failRun(run.id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async checkBuiltInRules(repoId: string): Promise<EnforcerViolation[]> {
    const violations: EnforcerViolation[] = [];

    // BP-05: Hardcoded Secrets
    const secretRegex =
      '(password|secret|api_key|access_token)[\\s:=]+[\'"][a-zA-Z0-9_\\-]{8,}[\'"]';
    const secretChunks = await this.chunkRepo
      .createQueryBuilder('chunk')
      .where('chunk.repo_id = :repoId', { repoId })
      .andWhere('chunk.chunk_text ~* :secretRegex', { secretRegex })
      .limit(20)
      .getMany();

    for (const c of secretChunks) {
      violations.push({
        ruleId: 'BP-05',
        name: 'Hardcoded Secrets',
        severity: AgentRuleSeverity.CRITICAL,
        file: c.filePath,
        line: c.lineStart,
        message: 'Potential hardcoded secret detected.',
      });
    }

    // BP-08: Console.log in Production
    const consoleChunks = await this.chunkRepo
      .createQueryBuilder('chunk')
      .where('chunk.repo_id = :repoId', { repoId })
      .andWhere("chunk.chunk_text ~ 'console\\.(log|debug|info)'")
      .andWhere("chunk.file_path NOT LIKE '%.spec.ts'")
      .andWhere("chunk.file_path NOT LIKE '%.test.ts'")
      .limit(20)
      .getMany();

    for (const c of consoleChunks) {
      violations.push({
        ruleId: 'BP-08',
        name: 'Console.log in Production',
        severity: AgentRuleSeverity.INFO,
        file: c.filePath,
        line: c.lineStart,
        message: 'Avoid console.log in production code. Use a logger.',
      });
    }

    // BP-04: Missing Auth Guard
    const unprotectedControllers = await this.chunkRepo
      .createQueryBuilder('chunk')
      .where('chunk.repo_id = :repoId', { repoId })
      .andWhere("chunk.nest_role = 'controller'")
      .andWhere("chunk.chunk_text NOT LIKE '%@UseGuards%'")
      .andWhere("chunk.chunk_text NOT LIKE '%@Auth%'")
      .andWhere("chunk.chunk_text NOT LIKE '%@Public%'")
      .getMany();

    for (const c of unprotectedControllers) {
        const hasClass = c.symbols?.some(s => s.kind === 'class' && s.decorators?.includes('Controller'));
        if (hasClass) {
            violations.push({
                ruleId: 'BP-04',
                name: 'Missing Auth Guard',
                severity: AgentRuleSeverity.WARNING,
                file: c.filePath,
                line: c.lineStart,
                message: 'Controller appears to be unprotected. Add @UseGuards() or @Public().',
            });
        }
    }

    return violations;
  }

  private async checkCustomRules(repoId: string): Promise<EnforcerViolation[]> {
    const rules = await this.ruleRepo.find({ where: { repoId, isActive: true } });
    const violations: EnforcerViolation[] = [];

    for (const rule of rules) {
      if (rule.detectionPattern?.regex) {
         const matches = await this.chunkRepo
          .createQueryBuilder('chunk')
          .where('chunk.repo_id = :repoId', { repoId })
          .andWhere(`chunk.chunk_text ~ :regex`, { regex: rule.detectionPattern.regex })
          .limit(20)
          .getMany();

         for (const c of matches) {
             violations.push({
                 ruleId: rule.id,
                 name: rule.name,
                 severity: rule.severity,
                 file: c.filePath,
                 line: c.lineStart,
                 message: rule.description,
             });
         }
      }
    }
    return violations;
  }
  
  async createRule(repoId: string, ruleData: Partial<AgentRule>): Promise<AgentRule> {
      const rule = this.ruleRepo.create({ ...ruleData, repoId });
      return this.ruleRepo.save(rule);
  }
  
  async listRules(repoId: string): Promise<AgentRule[]> {
      return this.ruleRepo.find({ where: { repoId } });
  }
}
