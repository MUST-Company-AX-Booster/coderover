import { Injectable, Logger, NotFoundException, UnprocessableEntityException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { CodeChunk } from '../../entities/code-chunk.entity';
import { CodeMethod } from '../../entities/code-method.entity';
import { Repo } from '../../entities/repo.entity';
import { AgentService } from '../agent.service';
import { AgentType, AgentTrigger } from '../../entities/agent-run.entity';
import { AgentMemoryService } from '../agent-memory/agent-memory.service';
import { AgentMemoryType } from '../../entities/agent-memory.entity';
import { AgentApprovalService } from '../agent-approval/agent-approval.service';
import { GitHubService } from '../../ingest/github.service';
import { AdminConfigService } from '../../admin/admin-config.service';
import { MemgraphService } from '../../graph/memgraph.service';
import OpenAI from 'openai';
import { TokenCapService } from '../../observability/token-cap.service';
import { currentOrgId } from '../../organizations/org-context';
import {
  createLocalChatCompletion,
  getLlmCredentialError,
  normalizeLlmApiKey,
  resolveLlmBaseUrl,
  resolveLlmProvider,
} from '../../config/openai.config';

export interface RefactorSuggestion {
  smellId: string;
  name: string;
  file: string;
  line?: number;
  severity: 'critical' | 'warning' | 'suggestion';
  message: string;
  context?: any;
}

@Injectable()
export class AgentRefactorService {
  private readonly logger = new Logger(AgentRefactorService.name);

  constructor(
    @InjectRepository(CodeChunk)
    private chunkRepo: Repository<CodeChunk>,
    @InjectRepository(CodeMethod)
    private methodRepo: Repository<CodeMethod>,
    @InjectRepository(Repo)
    private repoRepo: Repository<Repo>,
    private dataSource: DataSource,
    private agentService: AgentService,
    private memoryService: AgentMemoryService,
    @Inject(forwardRef(() => AgentApprovalService))
    private approvalService: AgentApprovalService,
    private githubService: GitHubService,
    private adminConfigService: AdminConfigService,
    private memgraphService: MemgraphService,
    private tokenCap: TokenCapService,
  ) {}

  async requestFix(repoId: string, suggestionId: string): Promise<any> {
    const run = await this.agentService.startRun(repoId, AgentType.REFACTOR, AgentTrigger.MANUAL);
    const payload = { repoId, suggestionId, runId: run.id, timestamp: Date.now() };
    
    const approval = await this.approvalService.createApproval(
      run.id,
      'APPLY_FIX',
      payload
    );
    
    return {
      message: 'Fix requested. Approval required.',
      approvalToken: approval.approvalToken,
      approvalUrl: `/agent/approval/${approval.approvalToken}/approve`
    };
  }

  async applyFix(payload: any): Promise<{ prUrl: string; prNumber: number; branchName: string }> {
    const repoId = String(payload.repoId);
    const suggestionId = String(payload.suggestionId);
    const runId = payload.runId ? String(payload.runId) : undefined;

    this.logger.log(`Applying fix for suggestion ${suggestionId} on repo ${repoId}`);

    try {
      const repo = await this.repoRepo.findOne({ where: { id: repoId } });
      if (!repo) throw new Error('Repo not found');
      if (!repo.githubToken) throw new Error('Repo is missing GitHub token');
      if (!repo.fullName) throw new Error('Repo is missing GitHub full name');

      const baseBranch = repo.branch || 'main';
      const suggestion = await this.resolveSuggestion(repoId, suggestionId);
      const filePath = suggestion.file;

      const baseSha = await this.githubService.getLatestCommitSha(repo.fullName, baseBranch, repo.githubToken);
      const branchName = this.buildFixBranchName(suggestionId);

      await this.githubService.createBranch(repo.fullName, branchName, baseSha, repo.githubToken);

      const originalContent = await this.githubService.getFileContent(repo.fullName, filePath, baseBranch, repo.githubToken);
      let attempt = await this.generateUpdatedFileContent({
        repoFullName: repo.fullName,
        filePath,
        baseBranch,
        suggestion,
        originalContent,
        attempt: 1,
      });

      const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();
      const origNorm = normalize(originalContent);

      if (normalize(attempt.content) === origNorm) {
        this.logger.warn(`Attempt 1 produced no changes. Requesting attempt 2 with stricter prompt.`);
        attempt = await this.generateUpdatedFileContent({
          repoFullName: repo.fullName,
          filePath,
          baseBranch,
          suggestion,
          originalContent,
          attempt: 2,
        });
      }

      const updatedContent = attempt.content;
      const updatedNorm = normalize(updatedContent);
      const tokensUsed = attempt.tokensUsed;

      if (updatedNorm === 'NO_CHANGES_NEEDED' || updatedNorm === origNorm) {
        this.logger.warn(`LLM failed to produce a diff. orig length: ${origNorm.length}, new length: ${updatedNorm.length}`);
        throw new UnprocessableEntityException('Generated fix produced no changes');
      }

      const commitMessage = `CodeRover fix: ${suggestion.smellId} (${filePath})`;
      await this.githubService.createOrUpdateFile(
        repo.fullName,
        filePath,
        branchName,
        updatedContent,
        commitMessage,
        repo.githubToken,
      );

      const prTitle = `CodeRover: ${suggestion.name} (${suggestion.smellId})`;
      const prBody = this.buildPrBody(suggestion, filePath);
      const pr = await this.githubService.createPullRequest(
        repo.fullName,
        prTitle,
        branchName,
        baseBranch,
        prBody,
        repo.githubToken,
      );

      if (runId) {
        await this.agentService.completeRun(runId, 1, tokensUsed, {
          prUrl: pr.url,
          prNumber: pr.number,
          branchName,
          filePath,
          suggestionId,
          smellId: suggestion.smellId,
        });
      }

      return { prUrl: pr.url, prNumber: pr.number, branchName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (runId) {
        await this.agentService.failRun(runId, message);
      }
      throw err;
    }
  }

  async scanRepo(repoId: string, trigger: AgentTrigger = AgentTrigger.MANUAL): Promise<RefactorSuggestion[]> {
    const run = await this.agentService.startRun(repoId, AgentType.REFACTOR, trigger);
    const suggestions: RefactorSuggestion[] = [];

    try {
      const repo = await this.repoRepo.findOne({ where: { id: repoId } });
      if (!repo) {
        throw new NotFoundException(`Repo ${repoId} not found`);
      }

      // 1. Long Function (CS-01)
      const longFunctions = await this.detectLongFunctions(repoId);
      suggestions.push(...longFunctions);

      // 2. God Class (CS-02)
      const godClasses = await this.detectGodClasses(repoId);
      suggestions.push(...godClasses);

      // 3. Duplicate Logic (CS-03)
      const duplicates = await this.detectDuplicates(repoId);
      suggestions.push(...duplicates);

      // 4. Deep Nesting (CS-04)
      const deepNesting = await this.detectDeepNesting(repoId);
      suggestions.push(...deepNesting);

      // 5. Large File (CS-05)
      const largeFiles = await this.detectLargeFiles(repoId);
      suggestions.push(...largeFiles);

      // 6. High Fan-Out (CS-06)
      const highFanOut = await this.detectHighFanOut(repoId);
      suggestions.push(...highFanOut);
      
      // 7. Architectural Smells (CS-07)
      const architectural = await this.detectArchitecturalSmells(repoId);
      suggestions.push(...architectural);

      // Filter dismissed
      const filtered = await this.filterDismissed(repoId, suggestions);
      
      // LLM Validation Phase
      const validated = await this.validateRisksWithLLM(repo.fullName, repo.branch, filtered);

      await this.agentService.completeRun(run.id, validated.length, 0, { suggestions: validated });
      return validated;
    } catch (err) {
      await this.agentService.failRun(run.id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async detectLongFunctions(repoId: string): Promise<RefactorSuggestion[]> {
    // Check CodeMethod where end_line - start_line > 80
    const methods = await this.methodRepo
      .createQueryBuilder('method')
      .where('method.repoId = :repoId', { repoId })
      .andWhere('(method.end_line - method.start_line) > 80')
      .getMany();

    return methods.map(m => ({
      smellId: 'CS-01',
      name: 'Long Function',
      file: m.filePath,
      line: m.startLine,
      severity: 'warning',
      message: `Function ${m.methodName} is too long (${m.endLine - m.startLine} lines). Consider extracting methods.`,
      context: { method: m.methodName },
    }));
  }

  private async detectGodClasses(repoId: string): Promise<RefactorSuggestion[]> {
    // Check > 15 methods OR > 500 lines
    // 1. > 15 methods
    const methodCounts = await this.methodRepo
      .createQueryBuilder('method')
      .select('method.className', 'className')
      .addSelect('method.filePath', 'filePath')
      .addSelect('COUNT(method.id)', 'count')
      .where('method.repoId = :repoId', { repoId })
      .andWhere('method.className IS NOT NULL')
      .groupBy('method.className, method.filePath')
      .having('COUNT(method.id) > 15')
      .getRawMany();

    // 2. > 500 lines (from chunks symbols)
    const largeClasses = await this.chunkRepo.query(`
      SELECT file_path, s->>'name' as class_name, (s->>'lineEnd')::int - (s->>'lineStart')::int as lines
      FROM code_chunks, jsonb_array_elements(symbols) s
      WHERE repo_id = $1
      AND s->>'kind' = 'class'
      AND ((s->>'lineEnd')::int - (s->>'lineStart')::int) > 500
    `, [repoId]);

    const suggestions: RefactorSuggestion[] = [];

    for (const m of methodCounts) {
      suggestions.push({
        smellId: 'CS-02',
        name: 'God Class',
        file: m.filePath,
        severity: 'critical',
        message: `Class ${m.className} has too many methods (${m.count}). Consider splitting responsibilities.`,
        context: { className: m.className },
      });
    }

    for (const c of largeClasses) {
      suggestions.push({
        smellId: 'CS-02',
        name: 'God Class',
        file: c.file_path,
        severity: 'critical',
        message: `Class ${c.class_name} is too large (${c.lines} lines). Consider splitting responsibilities.`,
        context: { className: c.class_name },
      });
    }

    return suggestions;
  }

  private async detectDuplicates(repoId: string): Promise<RefactorSuggestion[]> {
    const pairs = await this.chunkRepo.query(`
      SELECT a.file_path as file_a, b.file_path as file_b, 1 - (a.embedding <=> b.embedding) as similarity,
             a.line_start as line_a, b.line_start as line_b
      FROM code_chunks a
      JOIN code_chunks b ON a.repo_id = b.repo_id AND a.id < b.id
      WHERE a.repo_id = $1
      AND (a.embedding <=> b.embedding) < 0.08
      LIMIT 20
    `, [repoId]);

    return pairs.map((p: any) => ({
      smellId: 'CS-03',
      name: 'Duplicate Logic',
      file: p.file_a,
      line: p.line_a,
      severity: 'warning',
      message: `Possible duplicate logic found in ${p.file_b}:${p.line_b} (similarity: ${parseFloat(p.similarity).toFixed(2)}).`,
      context: { duplicateFile: p.file_b, duplicateLine: p.line_b },
    }));
  }

  private async detectDeepNesting(repoId: string): Promise<RefactorSuggestion[]> {
    const deepChunks = await this.chunkRepo
      .createQueryBuilder('chunk')
      .where('chunk.repoId = :repoId', { repoId })
      .andWhere("chunk.chunkText ~ '^\\s{16,}'")
      .limit(50)
      .getMany();

    return deepChunks.map(c => ({
      smellId: 'CS-04',
      name: 'Deep Nesting',
      file: c.filePath,
      line: c.lineStart,
      severity: 'suggestion',
      message: 'Deep nesting detected (>4 levels). Consider flattening logic or extracting methods.',
    }));
  }

  private async detectLargeFiles(repoId: string): Promise<RefactorSuggestion[]> {
    const largeFiles = await this.chunkRepo
      .createQueryBuilder('chunk')
      .select('chunk.filePath', 'filePath')
      .addSelect('MAX(chunk.line_end)', 'maxLine')
      .where('chunk.repoId = :repoId', { repoId })
      .groupBy('chunk.filePath')
      .having('MAX(chunk.line_end) > 400')
      .getRawMany();

    return largeFiles.map(f => ({
      smellId: 'CS-05',
      name: 'Large File',
      file: f.filePath,
      severity: 'suggestion',
      message: `File is too large (${f.maxLine} lines). Consider splitting into modules.`,
    }));
  }

  private async detectHighFanOut(repoId: string): Promise<RefactorSuggestion[]> {
    const fanOut = await this.chunkRepo.query(`
      SELECT file_path, SUM(jsonb_array_length(imports)) as import_count
      FROM code_chunks
      WHERE repo_id = $1
      AND imports IS NOT NULL
      GROUP BY file_path
      HAVING SUM(jsonb_array_length(imports)) > 10
    `, [repoId]);

    return fanOut.map((f: any) => ({
      smellId: 'CS-06',
      name: 'High Fan-Out',
      file: f.file_path,
      severity: 'suggestion',
      message: `High coupling detected (${f.import_count} imports).`,
    }));
  }

  private async detectArchitecturalSmells(repoId: string): Promise<RefactorSuggestion[]> {
    try {
      const cypher = `
        MATCH p=(f:File {repoId: $repoId})-[:IMPORTS*1..5]->(f)
        RETURN f.filePath AS filePath, [n in nodes(p) | n.filePath] AS cycle
        LIMIT 10
      `;
      const result = await this.memgraphService.readQuery(cypher, { repoId });
      
      return result.map(record => {
        const filePath = record.get('filePath') as string;
        const cycle = record.get('cycle') as string[];
        
        return {
          smellId: 'CS-07',
          name: 'Circular Dependency',
          file: filePath,
          severity: 'critical',
          message: `File is part of a circular dependency cycle: ${cycle.join(' -> ')}`,
          context: { cycle },
        };
      });
    } catch (error: any) {
      this.logger.warn(`Failed to detect architectural smells for repo ${repoId}: ${error.message}`);
      return [];
    }
  }

  private async validateRisksWithLLM(repoFullName: string, branch: string, risks: RefactorSuggestion[]): Promise<RefactorSuggestion[]> {
    if (!risks.length) return [];

    const llmConfig = await this.adminConfigService.getLlmConfig();
    const apiKey = normalizeLlmApiKey(await this.adminConfigService.getSecret('OPENAI_API_KEY'));
    
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not found. Skipping LLM validation.');
      return risks;
    }

    const provider = resolveLlmProvider(llmConfig.provider || undefined, apiKey, llmConfig.baseUrl || undefined);
    const credentialError = getLlmCredentialError(provider, apiKey);
    if (credentialError) {
      this.logger.warn(`Skipping LLM validation: ${credentialError}`);
      return risks;
    }

    const openai = new OpenAI({
      apiKey,
      baseURL: resolveLlmBaseUrl(provider, llmConfig.baseUrl || undefined, apiKey, 'chat'),
    });

    try {
      // Create a summary of risks for the LLM
      const riskSummary = risks.map((r, i) => ({
        index: i,
        file: r.file,
        name: r.name,
        message: r.message,
      }));

      const prompt = `
        You are an expert code reviewer analyzing potential code smells detected by a static scanner.
        Review the following list of flagged files and issues.
        Determine if each issue is a GENUINE architectural/code smell that needs refactoring, or a FALSE POSITIVE.
        
        Common False Positives:
        - index.ts / export barrels having "High Fan-Out"
        - *.spec.ts / *.test.ts having "Long Functions" or "Large Files"
        - Configuration files or auto-generated files
        - Intentional circular dependencies in type definitions
        
        Risks to evaluate:
        ${JSON.stringify(riskSummary, null, 2)}
        
        Return ONLY a JSON array of the indices of the GENUINE risks.
        Example output: [0, 2, 5]
      `;

      const response = provider === 'local'
        ? await createLocalChatCompletion({
            apiKey,
            baseUrl: llmConfig.baseUrl || undefined,
            model: llmConfig.chatModel || 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
          })
        : await (async () => {
            const orgId = currentOrgId();
            if (orgId) await this.tokenCap.guard(orgId);
            return openai.chat.completions.create({
              model: llmConfig.chatModel || 'gpt-4o-mini',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.1,
              response_format: { type: 'json_object' },
            });
          })();

      // Phase 9: record usage against org cap.
      const orgIdForUsage = currentOrgId();
      if (orgIdForUsage && response?.usage) {
        try {
          await this.tokenCap.recordUsage(
            orgIdForUsage,
            response.usage.prompt_tokens ?? 0,
            response.usage.completion_tokens ?? 0,
          );
        } catch { /* best-effort */ }
      }

      const content = response.choices[0]?.message?.content;
      if (!content) return risks;

      const resultObj = JSON.parse(content);
      const validIndices: number[] = Array.isArray(resultObj) ? resultObj : (resultObj.indices || []);
      
      // Filter the original array based on LLM validation
      const validatedRisks = risks.filter((_, i) => validIndices.includes(i));
      this.logger.log(`LLM Validation: Reduced ${risks.length} raw risks to ${validatedRisks.length} genuine risks.`);
      return validatedRisks;
      
    } catch (error: any) {
      this.logger.error(`Failed to validate risks with LLM: ${error.message}`);
      return risks; // Fallback to returning all risks if LLM fails
    }
  }

  private async filterDismissed(repoId: string, suggestions: RefactorSuggestion[]): Promise<RefactorSuggestion[]> {
    const dismissed = await this.memoryService.listMemory(repoId, AgentMemoryType.DISMISSED);
    const dismissedKeys = new Set(dismissed.map(m => m.key));

    return suggestions.filter(s => {
      const key = `${s.file}|${s.smellId}`;
      return !dismissedKeys.has(key);
    });
  }

  private parseSuggestionId(suggestionId: string): { filePath: string; smellId: string } {
    const idx = suggestionId.lastIndexOf('|');
    if (idx <= 0) {
      throw new Error('Invalid suggestionId format');
    }
    return { filePath: suggestionId.slice(0, idx), smellId: suggestionId.slice(idx + 1) };
  }

  private async resolveSuggestion(repoId: string, suggestionId: string): Promise<RefactorSuggestion> {
    const parsed = this.parseSuggestionId(suggestionId);
    const runs = await this.agentService.listRuns(repoId, 50, AgentType.REFACTOR);
    for (const run of runs) {
      const maybe = (run.metadata as any)?.suggestions;
      if (!Array.isArray(maybe)) continue;
      const found = maybe.find(
        (s: any) => typeof s?.file === 'string' && typeof s?.smellId === 'string' && s.file === parsed.filePath && s.smellId === parsed.smellId,
      );
      if (found) {
        return found as RefactorSuggestion;
      }
    }

    return {
      smellId: parsed.smellId,
      name: parsed.smellId,
      file: parsed.filePath,
      severity: 'suggestion',
      message: '',
    };
  }

  private buildFixBranchName(suggestionId: string): string {
    const safe = suggestionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
    return `coderover-fix-${safe}-${Date.now()}`;
  }

  private buildPrBody(suggestion: RefactorSuggestion, filePath: string): string {
    const parts = [
      'Automated refactor created by CodeRover.',
      '',
      `Target: ${filePath}`,
      `Smell: ${suggestion.smellId}`,
    ];
    if (suggestion.message) {
      parts.push(`Details: ${suggestion.message}`);
    }
    return parts.join('\n');
  }

  private sanitizeModelOutput(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.includes('```')) return trimmed;
    const fenceStart = trimmed.indexOf('```');
    const fenceEnd = trimmed.lastIndexOf('```');
    if (fenceStart === fenceEnd) return trimmed.replace(/```/g, '').trim();
    const inside = trimmed.slice(fenceStart + 3, fenceEnd);
    return inside.replace(/^\w+\n/, '').trim();
  }

  private async generateUpdatedFileContent(params: {
    repoFullName: string;
    filePath: string;
    baseBranch: string;
    suggestion: RefactorSuggestion;
    originalContent: string;
    attempt: 1 | 2;
  }): Promise<{ content: string; tokensUsed: number }> {
    const llmConfig = await this.adminConfigService.getLlmConfig();
    const apiKey = normalizeLlmApiKey(await this.adminConfigService.getSecret('OPENAI_API_KEY'));
    if (!apiKey) {
      throw new Error('Missing LLM API key (OPENAI_API_KEY)');
    }

    const provider = resolveLlmProvider(llmConfig.provider || undefined, apiKey, llmConfig.baseUrl || undefined);
    const credentialError = getLlmCredentialError(provider, apiKey);
    if (credentialError) {
      throw new Error(credentialError);
    }

    const openai = new OpenAI({
      apiKey,
      baseURL: resolveLlmBaseUrl(
        provider,
        llmConfig.baseUrl || undefined,
        apiKey,
        'chat',
      ),
    });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          params.attempt === 1
            ? 'You are a senior software engineer. Refactor code to address the described code smell without changing behavior. Return only the updated file content. Do not include markdown or code fences. Do not add comments.'
            : 'You are a senior software engineer. Refactor code to address the described code smell without changing behavior. Return only the updated file content. Do not include markdown or code fences. Do not add comments. You must either produce a meaningful change, or return exactly: NO_CHANGES_NEEDED',
      },
      {
        role: 'user',
        content: [
          `Repository: ${params.repoFullName}`,
          `Branch: ${params.baseBranch}`,
          `File: ${params.filePath}`,
          `Smell: ${params.suggestion.smellId}`,
          `Suggestion name: ${params.suggestion.name}`,
          params.suggestion.message ? `Suggestion details: ${params.suggestion.message}` : undefined,
          params.suggestion.context ? `Suggestion context JSON: ${JSON.stringify(params.suggestion.context)}` : undefined,
          params.attempt === 2 ? 'Constraint: make at least one safe refactor change, or return NO_CHANGES_NEEDED.' : undefined,
          '',
          'Current file content:',
          params.originalContent,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    const resp = provider === 'local'
      ? await createLocalChatCompletion({
          apiKey,
          baseUrl: llmConfig.baseUrl || undefined,
          model: llmConfig.chatModel || 'gpt-4o-mini',
          temperature: 0.2,
          messages: messages.map((message) => ({
            role: message.role,
            content: 'content' in message ? message.content : '',
          })),
        })
      : await openai.chat.completions.create({
          model: llmConfig.chatModel || 'gpt-4o-mini',
          temperature: 0.2,
          messages,
        });

    const raw = resp.choices?.[0]?.message?.content ?? '';
    const content = this.sanitizeModelOutput(raw);
    if (!content) {
      throw new Error('LLM returned empty content');
    }

    const tokensUsed = resp.usage?.total_tokens ?? 0;
    return { content, tokensUsed };
  }
}
