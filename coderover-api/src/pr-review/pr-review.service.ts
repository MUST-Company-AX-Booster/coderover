import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrReview } from '../entities/pr-review.entity';
import {
  PrReviewFinding,
  FindingSeverity,
} from '../entities/pr-review-finding.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';
import { MemgraphService } from '../graph/memgraph.service';
import { ConfidenceTaggerService } from '../graph/confidence-tagger.service';
import { GitHubTokenResolver } from '../github-integration/github-token-resolver.service';
import { SearchService, SearchResult as CodeSearchResult } from '../search/search.service';
import { EventsService } from '../events/events.service';
import { currentOrgId } from '../organizations/org-context';
import { GitHubAppService } from '../github-integration/github-app.service';
import {
  GitHubService,
  PrCommit,
  PrFile,
  PrInfo,
  RelatedIssueOrPr,
} from '../ingest/github.service';
import { Repo } from '../entities/repo.entity';
import {
  createLocalChatCompletion,
  resolveLlmBaseUrl,
  resolveLlmProvider,
} from '../config/openai.config';

export interface ReviewFinding {
  severity: 'critical' | 'warning' | 'suggestion' | 'info';
  file: string;
  line?: number;
  message: string;
  category: 'security' | 'performance' | 'correctness' | 'style' | 'maintainability';
}

export interface ReviewResult {
  prNumber: number;
  repo: string;
  summary: string;
  findings: ReviewFinding[];
  score: number; // 0-100, higher = better
  recommendation: 'approve' | 'request_changes' | 'comment';
  postedCommentUrl: string | null;
  prReviewId: string;
  tokensUsed: number | null;
}

interface HistoricalReviewPatterns {
  totalReviews: number;
  avgScore: number | null;
  commonCategories: string[];
  recentFailureRate: number;
}

@Injectable()
export class PrReviewService {
  private readonly logger = new Logger(PrReviewService.name);
  private readonly openai: OpenAI;
  private readonly llmProvider: string;
  private readonly chatModel: string;

  constructor(
    @InjectRepository(PrReview)
    private readonly prReviewRepository: Repository<PrReview>,

    @InjectRepository(WebhookEvent)
    private readonly webhookEventRepository: Repository<WebhookEvent>,

    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,

    @InjectRepository(PrReviewFinding)
    private readonly findingRepository: Repository<PrReviewFinding>,

    private readonly configService: ConfigService,
    private readonly githubService: GitHubService,
    private readonly dataSource: DataSource,
    private readonly memgraphService: MemgraphService,
    private readonly searchService: SearchService,
    private readonly eventsService: EventsService,
    private readonly githubAppService: GitHubAppService,
    private readonly tokenResolver: GitHubTokenResolver,
    private readonly confidenceTagger: ConfidenceTaggerService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const configuredBaseURL = this.configService.get<string>('OPENAI_BASE_URL');
    const resolvedProvider = resolveLlmProvider(
      this.configService.get<string>('LLM_PROVIDER'),
      apiKey,
      configuredBaseURL,
    );
    const baseURL = resolveLlmBaseUrl(resolvedProvider, configuredBaseURL, apiKey, 'chat');

    this.openai = new OpenAI({ apiKey, baseURL });

    this.llmProvider = resolvedProvider;

    const defaultModel =
      this.llmProvider === 'openrouter' ? 'anthropic/claude-3.5-sonnet' : 'gpt-4o-mini';
    this.chatModel =
      this.configService.get<string>('OPENAI_CHAT_MODEL') || defaultModel;
  }

  // ─── Webhook Processing ─────────────────────────────────────────────────────

  /**
   * Log a raw GitHub webhook payload and return the saved event.
   */
  async logWebhookEvent(
    eventType: string,
    payload: any,
  ): Promise<WebhookEvent> {
    const event = this.webhookEventRepository.create({
      eventType,
      action: payload?.action ?? null,
      repo: payload?.repository?.full_name ?? 'unknown',
      ref: payload?.ref ?? null,
      commitSha: payload?.after ?? payload?.pull_request?.head?.sha ?? null,
      prNumber: payload?.pull_request?.number ?? null,
      sender: payload?.sender?.login ?? null,
      payload,
      processed: false,
    });

    return this.webhookEventRepository.save(event);
  }

  /**
   * Mark a webhook event as processed (or failed with an error message).
   */
  async markEventProcessed(id: string, error?: string): Promise<void> {
    await this.webhookEventRepository.update(id, {
      processed: !error,
      error: error ?? null,
    });
  }

  // ─── PR Review ───────────────────────────────────────────────────────────────

  /**
   * Full PR review pipeline:
   * 1. Fetch PR metadata + diff from GitHub
   * 2. Analyse with AI
   * 3. Persist to pr_reviews
   * 4. Post comment to GitHub (if postComment=true)
   */
  async reviewPullRequest(
    repo: string,
    prNumber: number,
    options: { postComment?: boolean; repoId?: string; installationId?: number } = {},
  ): Promise<ReviewResult> {
    const normalizedRepo = this.normalizeRepoInput(repo);
    this.logger.log(`Reviewing PR #${prNumber} in ${normalizedRepo}`);

    const repoEntity = options.repoId
      ? await this.repoRepository.findOne({ where: { id: options.repoId } })
      : await this.repoRepository.findOne({ where: { fullName: ILike(normalizedRepo) } });
    const resolvedRepo = repoEntity?.fullName ?? normalizedRepo;

    // Phase 10 (2026-04-16): resolve token live so OAuth-connected repos
    // always use the freshest access token from github_connections. Manual
    // PAT repos keep their stored token. Final fallback is env GITHUB_TOKEN.
    const token = repoEntity
      ? (await this.tokenResolver.resolveFor(repoEntity)) || undefined
      : undefined;

    let prRecord = this.prReviewRepository.create({
      prNumber,
      repo: resolvedRepo,
      repoId: repoEntity?.id ?? null,
      status: 'in_progress',
      aiModel: this.chatModel,
      orgId: currentOrgId() ?? null,
    });
    prRecord = await this.prReviewRepository.save(prRecord);

    // Phase 9 / Workstream B: open a GitHub check_run if App credentials +
    // installationId are available. Silent no-op otherwise.
    let checkRunId: number | null = null;
    const [ownerSeg, repoSeg] = resolvedRepo.split('/');

    try {
      const prInfo = await this.githubService.getPrInfo(resolvedRepo, prNumber, token);
      const files = await this.githubService.getPrFiles(resolvedRepo, prNumber, token);
      if (
        options.installationId &&
        ownerSeg &&
        repoSeg &&
        this.githubAppService.isConfigured()
      ) {
        try {
          checkRunId = await this.githubAppService.createCheckRun(
            options.installationId,
            ownerSeg,
            repoSeg,
            prInfo.headSha,
            'in_progress',
          );
          this.logger.log(`Opened check_run ${checkRunId} for ${resolvedRepo}#${prNumber}`);
        } catch (err) {
          this.logger.warn(
            `check_run create failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const commits = await this.githubService.getPrCommits(resolvedRepo, prNumber, token);
      const relatedReferences = this.extractIssueReferences(
        [prInfo.body ?? '', ...commits.map((commit) => commit.message)].join('\n'),
      );
      const relatedItems = await this.githubService.getRelatedIssuesAndPrs(
        resolvedRepo,
        relatedReferences,
        token,
      );
      const repositoryStructure = await this.githubService.getRepositoryStructure(
        resolvedRepo,
        prInfo.baseBranch,
        token,
      );
      const historicalPatterns = await this.getHistoricalReviewPatterns(resolvedRepo);
      const filteredFiles = this.filterFilesForContext(files);
      const deterministicFindings = this.runDeterministicChecks(filteredFiles, commits);

      const graphRag = repoEntity?.id
        ? await this.buildGraphRagContext(repoEntity.id, prInfo, filteredFiles, commits)
        : { contextText: null, findings: [] };

      // Phase 10 B2: keys of findings that originated from deterministic
      // producers (runDeterministicChecks + graph-rag). After the AI merges
      // its own findings in, we use these keys to tag each row EXTRACTED
      // vs INFERRED without a second pass of source tracking.
      const deterministicKeys = new Set(
        [...deterministicFindings, ...graphRag.findings].map((f) => findingKey(f)),
      );

      // 2. Build diff summary (truncated to stay within context limits)
      const diffSummary = this.buildDiffSummary(
        prInfo,
        filteredFiles,
        commits,
        relatedItems,
        repositoryStructure,
        historicalPatterns,
        graphRag.contextText,
      );

      // 3. AI analysis
      const analysis = await this.analyseWithAi(
        prInfo,
        diffSummary,
        resolvedRepo,
        this.mergeFindings(deterministicFindings, graphRag.findings),
      );

      // 4. Persist findings
      prRecord.diffSummary = diffSummary;
      prRecord.findings = {
        score: analysis.score,
        recommendation: analysis.recommendation,
        items: analysis.findings,
      };
      prRecord.status = 'completed';
      prRecord.llmLatencyMs = analysis.telemetry.latencyMs;
      prRecord.llmDurationMs = analysis.telemetry.durationMs;
      prRecord.promptTokens = analysis.telemetry.promptTokens;
      prRecord.completionTokens = analysis.telemetry.completionTokens;
      prRecord.totalTokens = analysis.telemetry.totalTokens;

      // 5. Post comment to GitHub if requested
      let postedCommentUrl: string | null = null;
      if (options.postComment !== false) {
        try {
          const commentBody = this.formatReviewComment(analysis, prInfo);
          const { commentId, url } = await this.githubService.postPrReviewComment(
            resolvedRepo,
            prNumber,
            commentBody,
            token,
          );
          prRecord.githubCommentId = String(commentId);
          prRecord.reviewUrl = url;
          prRecord.postedAt = new Date();
          postedCommentUrl = url;
        } catch (postErr) {
          this.logger.warn(
            `Could not post PR comment: ${postErr instanceof Error ? postErr.message : String(postErr)}`,
          );
        }
      }

      await this.prReviewRepository.save(prRecord);

      // Phase 10 B2: mirror each finding into pr_review_findings with a
      // confidence tag so the UI's ConfidenceMark can render per-finding.
      // Deterministic (AST/rule/graph-rag) → EXTRACTED. AI-derived →
      // INFERRED when the model returned a confidence, else AMBIGUOUS.
      // Best-effort: failure here doesn't fail the review.
      try {
        await this.writePrReviewFindings(
          prRecord.id,
          repoEntity?.id ?? null,
          analysis.findings,
          deterministicKeys,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to persist pr_review_findings for review ${prRecord.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      await this.recordTelemetry({
        status: 'completed',
        repoId: repoEntity?.id ?? null,
        repo: resolvedRepo,
        prReviewId: prRecord.id,
        telemetry: analysis.telemetry,
      });
      if (repoEntity?.id) {
        this.eventsService.publish(`repo:${repoEntity.id}`, 'pr.review.ready', {
          repoId: repoEntity.id,
          prNumber,
          prReviewId: prRecord.id,
          score: analysis.score,
          recommendation: analysis.recommendation,
        });
      }

      // Phase 9 / Workstream B: close check_run with conclusion.
      if (checkRunId && options.installationId && ownerSeg && repoSeg) {
        try {
          const conclusion: 'success' | 'failure' | 'neutral' =
            analysis.recommendation === 'request_changes' ? 'failure' : 'neutral';
          const summary =
            `Score: ${analysis.score}/10 — ${analysis.findings?.length ?? 0} finding(s)`;
          await this.githubAppService.completeCheckRun(
            options.installationId,
            ownerSeg,
            repoSeg,
            checkRunId,
            conclusion,
            summary,
            analysis.summary,
          );
        } catch (err) {
          this.logger.warn(
            `check_run complete failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        prNumber,
        repo: resolvedRepo,
        summary: analysis.summary,
        findings: analysis.findings,
        score: analysis.score,
        recommendation: analysis.recommendation,
        postedCommentUrl,
        prReviewId: prRecord.id,
        tokensUsed: analysis.telemetry.totalTokens,
      };
    } catch (err) {
      prRecord.status = 'failed';
      await this.prReviewRepository.save(prRecord);
      if (checkRunId && options.installationId && ownerSeg && repoSeg) {
        try {
          await this.githubAppService.completeCheckRun(
            options.installationId, ownerSeg, repoSeg, checkRunId,
            'failure',
            'Review failed',
            err instanceof Error ? err.message : String(err),
          );
        } catch { /* best-effort */ }
      }
      await this.recordTelemetry({
        status: 'failed',
        repoId: repoEntity?.id ?? null,
        repo: resolvedRepo,
        prReviewId: prRecord.id,
        telemetry: {
          startedAt: new Date(),
          firstTokenAt: null,
          completedAt: new Date(),
          latencyMs: null,
          durationMs: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          provider: this.llmProvider,
          model: this.chatModel,
        },
        error: this.extractErrorMessage(err),
      });
      this.rethrowAsHttpError(err, resolvedRepo, prNumber);
    }
  }

  private normalizeRepoInput(repo: string): string {
    const input = (repo ?? '').trim();
    if (!input) {
      throw new BadRequestException('repo is required');
    }
    const { owner, repo: repoName } = this.githubService.parseRepo(input);
    return `${owner}/${repoName}`;
  }

  private extractErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private rethrowAsHttpError(err: unknown, repo: string, prNumber: number): never {
    const status = typeof err === 'object' && err && 'status' in err ? Number((err as any).status) : undefined;
    const message = this.extractErrorMessage(err);

    if (status === 401 || /bad credentials/i.test(message)) {
      throw new UnauthorizedException(
        `GitHub authentication failed for ${repo}. Update repository token or GITHUB_TOKEN.`,
      );
    }

    if (status === 404 || /not found/i.test(message)) {
      throw new NotFoundException(
        `PR #${prNumber} not found in ${repo}. Verify owner/repo, PR number, and token repository access.`,
      );
    }

    throw err instanceof Error ? err : new Error(message);
  }

  /**
   * Get an existing PR review by repo + PR number (latest).
   */
  async getReview(repo: string, prNumber: number): Promise<PrReview | null> {
    return this.prReviewRepository.findOne({
      where: { repo, prNumber },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * List recent PR reviews.
   */
  async listReviews(limit = 20): Promise<PrReview[]> {
    // Security fix 2026-04-15: fail closed when orgId is missing.
    const orgId = currentOrgId();
    if (!orgId) throw new ForbiddenException('Organization scope required');
    return this.prReviewRepository.find({
      where: { orgId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ─── Webhook Event Accessors ─────────────────────────────────────────────────

  async listWebhookEvents(limit = 50): Promise<WebhookEvent[]> {
    return this.webhookEventRepository.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private buildDiffSummary(
    prInfo: PrInfo,
    files: PrFile[],
    commits: PrCommit[],
    relatedItems: RelatedIssueOrPr[],
    repositoryStructure: string[],
    historicalPatterns: HistoricalReviewPatterns,
    graphRagContext: string | null,
  ): string {
    const MAX_DIFF_CHARS = 14000;
    const lines: string[] = [
      `PR #${prInfo.number}: ${prInfo.title}`,
      `Author: ${prInfo.author}`,
      `Branch: ${prInfo.headBranch} → ${prInfo.baseBranch}`,
      `Files changed: ${files.length}`,
      `Commits: ${commits.length}`,
      '',
    ];

    if (prInfo.body) {
      lines.push(`Description: ${prInfo.body.slice(0, 900)}`);
      lines.push('');
    }

    if (commits.length > 0) {
      lines.push('Commit History:');
      for (const commit of commits.slice(0, 20)) {
        lines.push(`- ${commit.sha.slice(0, 8)} ${commit.author}: ${commit.message.slice(0, 220)}`);
      }
      lines.push('');
    }

    if (relatedItems.length > 0) {
      lines.push('Related Issues / PRs:');
      for (const item of relatedItems.slice(0, 10)) {
        lines.push(`- ${item.type} #${item.number} (${item.state}): ${item.title.slice(0, 180)}`);
      }
      lines.push('');
    }

    lines.push('Repository Structure (sample):');
    for (const path of repositoryStructure.slice(0, 120)) {
      lines.push(`- ${path}`);
    }
    lines.push('');

    lines.push('Historical Review Patterns:');
    lines.push(
      `- reviews=${historicalPatterns.totalReviews}, avgScore=${historicalPatterns.avgScore ?? 'n/a'}, failureRate=${historicalPatterns.recentFailureRate}%`,
    );
    lines.push(`- commonCategories=${historicalPatterns.commonCategories.join(', ') || 'none'}`);
    lines.push('');

    if (graphRagContext) {
      lines.push('Code Graph + RAG Context:');
      lines.push(graphRagContext);
      lines.push('');
    }

    lines.push('Review Standards:');
    lines.push('- Prioritize security vulnerabilities and authorization logic correctness.');
    lines.push('- Analyze performance impact of loops, queries, payload size, and sync I/O.');
    lines.push('- Validate dependency and lockfile changes for risk and licensing impact.');
    lines.push('- Recommend automated tests for changed critical paths.');
    lines.push('');

    for (const file of files) {
      lines.push(
        `--- ${file.filename} (${file.status}: +${file.additions}/-${file.deletions}, changes=${file.changes ?? file.additions + file.deletions})`,
      );
      if (file.previousFilename) {
        lines.push(`renamed_from: ${file.previousFilename}`);
      }
      if (file.patch) {
        const patchPreview = file.patch.length > 2200 ? file.patch.slice(0, 2200) + '\n...' : file.patch;
        lines.push(patchPreview);
      }
      lines.push('');
    }

    const full = lines.join('\n');
    return full.length > MAX_DIFF_CHARS ? full.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated]' : full;
  }

  private async buildGraphRagContext(
    repoId: string,
    prInfo: PrInfo,
    files: PrFile[],
    commits: PrCommit[],
  ): Promise<{ contextText: string | null; findings: ReviewFinding[] }> {
    const topFiles = files
      .map((f) => f.filename)
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .slice(0, 8);

    if (topFiles.length === 0) return { contextText: null, findings: [] };

    const lines: string[] = [];
    const findings: ReviewFinding[] = [];

    const graphSection = await this.buildGraphImpactSection(repoId, topFiles);
    if (graphSection.sectionText) {
      lines.push('Graph Impact (imports/dependents/cycles):');
      lines.push(graphSection.sectionText);
      lines.push('');
      findings.push(...graphSection.findings);
    }

    const ragSection = await this.buildRagContextSection(repoId, prInfo, topFiles, commits);
    if (ragSection) {
      lines.push('Relevant Code Context (RAG):');
      lines.push(ragSection);
      lines.push('');
    }

    const text = lines.join('\n').trim();
    if (!text) return { contextText: null, findings };

    const MAX_CONTEXT_CHARS = 4200;
    const truncated = text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) + '\n[context truncated]' : text;
    return { contextText: truncated, findings: findings.slice(0, 15) };
  }

  private async buildGraphImpactSection(
    repoId: string,
    filePaths: string[],
  ): Promise<{ sectionText: string | null; findings: ReviewFinding[] }> {
    const lines: string[] = [];
    const findings: ReviewFinding[] = [];

    try {
      for (const filePath of filePaths) {
        const summaryRecords = await this.memgraphService.readQuery(
          `
          MATCH (f:File {repoId: $repoId, filePath: $filePath})
          OPTIONAL MATCH (f)-[:IMPORTS]->(out:File {repoId: $repoId})
          WITH f, collect(DISTINCT out.filePath) AS importsAll
          OPTIONAL MATCH (f)<-[:IMPORTS]-(inp:File {repoId: $repoId})
          WITH f, importsAll, collect(DISTINCT inp.filePath) AS importedByAll
          RETURN
            f.filePath AS filePath,
            size(importsAll) AS importsCount,
            size(importedByAll) AS importedByCount,
            importsAll[0..10] AS importsPreview,
            importedByAll[0..10] AS importedByPreview
          `,
          { repoId, filePath },
        );

        const row = summaryRecords?.[0]?.toObject?.() ?? null;
        if (!row?.filePath) continue;

        const importsCount = Number(row.importsCount ?? 0);
        const importedByCount = Number(row.importedByCount ?? 0);
        const importsPreview = Array.isArray(row.importsPreview) ? row.importsPreview : [];
        const importedByPreview = Array.isArray(row.importedByPreview) ? row.importedByPreview : [];

        lines.push(`- ${row.filePath}`);
        lines.push(`  - imports=${importsCount}, importedBy=${importedByCount}`);

        if (importsPreview.length > 0) {
          lines.push(`  - importsPreview: ${importsPreview.slice(0, 10).join(', ')}`);
        }
        if (importedByPreview.length > 0) {
          lines.push(`  - importedByPreview: ${importedByPreview.slice(0, 10).join(', ')}`);
        }

        const cycle = await this.memgraphService.readQuery(
          `
          MATCH p=(f:File {repoId: $repoId, filePath: $filePath})-[:IMPORTS*1..6]->(f)
          RETURN [n IN nodes(p) | n.filePath] AS cycle
          LIMIT 1
          `,
          { repoId, filePath },
        );

        const cycleRow = cycle?.[0]?.toObject?.() ?? null;
        const cycleList = Array.isArray(cycleRow?.cycle) ? cycleRow.cycle : [];
        if (cycleList.length > 0) {
          lines.push(`  - cycleDetected: ${cycleList.join(' -> ')}`);
        }

        if (importedByCount >= 25) {
          findings.push({
            severity: 'warning',
            file: row.filePath,
            message: `High fan-in detected (${importedByCount} dependents). Validate backwards compatibility and add regression tests.`,
            category: 'maintainability',
          });
        }
        if (cycleList.length > 0) {
          findings.push({
            severity: 'suggestion',
            file: row.filePath,
            message: 'Import cycle detected involving this file. Consider breaking the cycle to reduce coupling.',
            category: 'maintainability',
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Graph impact query skipped: ${message}`);
      return { sectionText: null, findings: [] };
    }

    const text = lines.join('\n').trim();
    return { sectionText: text || null, findings };
  }

  private async buildRagContextSection(
    repoId: string,
    prInfo: PrInfo,
    filePaths: string[],
    commits: PrCommit[],
  ): Promise<string | null> {
    const lines: string[] = [];

    try {
      const queryText = [
        prInfo.title,
        prInfo.body ?? '',
        ...commits.slice(0, 6).map((c) => c.message),
      ]
        .join('\n')
        .trim();

      const retrieved = queryText
        ? await this.searchService.search(queryText, { repoId, topK: 6, searchMode: 'hybrid' })
        : [];

      const selected = this.pickDiverseSearchResults(retrieved, 6);
      if (selected.length > 0) {
        for (const item of selected) {
          const snippet = String(item.chunkText ?? '')
            .replace(/\s+$/g, '')
            .slice(0, 600);
          lines.push(`- ${item.filePath}:${item.lineStart}-${item.lineEnd}`);
          lines.push(snippet);
          lines.push('');
        }
      }

      for (const filePath of filePaths.slice(0, 4)) {
        const rows = await this.dataSource.query(
          `
          SELECT file_path AS "filePath", line_start AS "lineStart", line_end AS "lineEnd", chunk_text AS "chunkText"
          FROM code_chunks
          WHERE repo_id = $1 AND file_path = $2
          ORDER BY line_start ASC
          LIMIT 2
          `,
          [repoId, filePath],
        );
        if (Array.isArray(rows) && rows.length > 0) {
          lines.push(`- fileContext: ${filePath}`);
          for (const row of rows) {
            const snippet = String(row.chunkText ?? '').replace(/\s+$/g, '').slice(0, 600);
            lines.push(`  - lines ${row.lineStart}-${row.lineEnd}`);
            lines.push(snippet);
          }
          lines.push('');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`RAG context skipped: ${message}`);
      return null;
    }

    const text = lines.join('\n').trim();
    return text || null;
  }

  private pickDiverseSearchResults(results: CodeSearchResult[], limit: number): CodeSearchResult[] {
    if (!Array.isArray(results) || results.length === 0) return [];
    const picked: CodeSearchResult[] = [];
    const seenFiles = new Set<string>();
    for (const result of results) {
      if (picked.length >= limit) break;
      if (!result?.filePath) continue;
      if (seenFiles.has(result.filePath)) continue;
      picked.push(result);
      seenFiles.add(result.filePath);
    }
    for (const result of results) {
      if (picked.length >= limit) break;
      if (!result?.filePath) continue;
      if (picked.includes(result)) continue;
      picked.push(result);
    }
    return picked.slice(0, limit);
  }

  private async analyseWithAi(
    prInfo: PrInfo,
    diffSummary: string,
    repo: string,
    deterministicFindings: ReviewFinding[],
  ): Promise<{
    summary: string;
    findings: ReviewFinding[];
    score: number;
    recommendation: 'approve' | 'request_changes' | 'comment';
    telemetry: {
      startedAt: Date;
      firstTokenAt: Date | null;
      completedAt: Date;
      latencyMs: number | null;
      durationMs: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      provider: string;
      model: string;
    };
  }> {
    const systemPrompt = `You are an expert code reviewer. Analyse the provided pull request context and return a JSON object with the following structure:
{
  "summary": "2-3 sentence overall assessment",
  "findings": [
    {
      "severity": "critical|warning|suggestion|info",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "Description of the issue",
      "category": "security|performance|correctness|style|maintainability"
    }
  ],
  "score": 85,
  "recommendation": "approve|request_changes|comment",
  "testingSuggestions": ["Specific automated test suggestion"]
}

Guidelines:
- Use full PR context: modified files, deleted lines, renames, commit history, linked issues/PRs, and repository structure.
- Emphasize security vulnerabilities, performance impact, dependency validation, and testing recommendations.
- Keep findings concrete with exact file references where possible.
- Score: 0-100 (100 = excellent, 0 = critical risk).`;

    const userPrompt = `Repository: ${repo}\n\n${diffSummary}`;
    const startedAt = new Date();

    try {
      const response = this.llmProvider === 'local'
        ? await createLocalChatCompletion({
            apiKey: this.configService.get<string>('OPENAI_API_KEY'),
            baseUrl: this.configService.get<string>('OPENAI_BASE_URL'),
            model: this.chatModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.1,
            maxTokens: 2000,
          })
        : await this.openai.chat.completions.create({
            model: this.chatModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' as const },
            temperature: 0.1,
            max_tokens: 2000,
          });
      const completedAt = new Date();
      const usage = response.usage;
      const durationMs = completedAt.getTime() - startedAt.getTime();

      const content = response.choices[0]?.message?.content ?? '{}';
      const parsed = this.parseAiContent(content);

      const aiFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
      const mergedFindings = this.mergeFindings(aiFindings, deterministicFindings);
      const finalScore = this.computeScore(
        typeof parsed.score === 'number' ? parsed.score : 75,
        mergedFindings,
      );
      const recommendation = this.resolveRecommendation(parsed.recommendation, mergedFindings, finalScore);
      const testingSuggestions = Array.isArray(parsed.testingSuggestions)
        ? parsed.testingSuggestions.filter((item) => typeof item === 'string').slice(0, 5)
        : [];
      const summarySuffix = testingSuggestions.length > 0
        ? ` Testing: ${testingSuggestions.join(' | ')}`
        : '';

      return {
        summary: `${parsed.summary ?? 'Review completed.'}${summarySuffix}`,
        findings: mergedFindings,
        score: finalScore,
        recommendation,
        telemetry: {
          startedAt,
          firstTokenAt: completedAt,
          completedAt,
          latencyMs: durationMs,
          durationMs,
          promptTokens: usage?.prompt_tokens ?? null,
          completionTokens: usage?.completion_tokens ?? null,
          totalTokens: usage?.total_tokens ?? null,
          provider: this.llmProvider,
          model: this.chatModel,
        },
      };
    } catch (err) {
      this.logger.error(`AI analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      const fallback = this.localFallbackAnalysis(
        prInfo,
        diffSummary,
        `AI analysis failed (${this.llmProvider} provider).`,
      );

      return {
        ...fallback,
        findings: this.mergeFindings(fallback.findings, deterministicFindings),
        score: this.computeScore(fallback.score, this.mergeFindings(fallback.findings, deterministicFindings)),
        telemetry: {
          startedAt,
          firstTokenAt: null,
          completedAt: new Date(),
          latencyMs: null,
          durationMs: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          provider: this.llmProvider,
          model: this.chatModel,
        },
      };
    }
  }

  private async recordTelemetry(params: {
    status: 'completed' | 'failed';
    repoId: string | null;
    repo: string;
    prReviewId: string;
    telemetry: {
      startedAt: Date;
      firstTokenAt: Date | null;
      completedAt: Date;
      latencyMs: number | null;
      durationMs: number | null;
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      provider: string;
      model: string;
    };
    error?: string;
  }): Promise<void> {
    try {
      await this.dataSource.query(
        `
          INSERT INTO ai_request_metrics (
            source,
            status,
            repo_id,
            repo_full_name,
            pr_review_id,
            provider,
            model,
            started_at,
            first_token_at,
            completed_at,
            latency_ms,
            duration_ms,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            metadata
          )
          VALUES (
            'pr_review', $1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb
          )
        `,
        [
          params.status,
          params.repoId,
          params.repo,
          params.prReviewId,
          params.telemetry.provider,
          params.telemetry.model,
          params.telemetry.startedAt,
          params.telemetry.firstTokenAt,
          params.telemetry.completedAt,
          params.telemetry.latencyMs,
          params.telemetry.durationMs,
          params.telemetry.promptTokens,
          params.telemetry.completionTokens,
          params.telemetry.totalTokens,
          JSON.stringify(params.error ? { error: params.error } : {}),
        ],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist PR telemetry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private parseAiContent(content: string): Record<string, any> {
    try {
      return JSON.parse(content);
    } catch {
      const fenced = content.match(/```json\s*([\s\S]*?)```/i)?.[1];
      if (fenced) {
        return JSON.parse(fenced.trim());
      }
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(content.slice(firstBrace, lastBrace + 1));
      }
      throw new Error('Model response did not contain valid JSON');
    }
  }

  private localFallbackAnalysis(
    prInfo: PrInfo,
    diffSummary: string,
    reason = 'Manual AI analysis unavailable.',
  ): {
    summary: string;
    findings: ReviewFinding[];
    score: number;
    recommendation: 'approve' | 'request_changes' | 'comment';
  } {
    const findings: ReviewFinding[] = [];
    findings.push(...this.runDeterministicChecks([{ filename: 'summary', status: 'modified', additions: 0, deletions: 0, patch: diffSummary }], []));

    return {
      summary: `PR #${prInfo.number} "${prInfo.title}" by ${prInfo.author}. ${reason} Basic static checks applied.`,
      findings,
      score: this.computeScore(70, findings),
      recommendation: this.resolveRecommendation('comment', findings, this.computeScore(70, findings)),
    };
  }

  private filterFilesForContext(files: PrFile[]): PrFile[] {
    return [...files]
      .sort((a, b) => {
        const aRisk = this.getFileRiskScore(a);
        const bRisk = this.getFileRiskScore(b);
        return bRisk - aRisk;
      })
      .slice(0, 80);
  }

  private getFileRiskScore(file: PrFile): number {
    const path = file.filename.toLowerCase();
    const base = (file.changes ?? file.additions + file.deletions) + file.deletions * 1.2;
    const securityBoost = /(auth|login|token|permission|role|secret|key|crypto)/.test(path) ? 80 : 0;
    const dependencyBoost = /(package\.json|package-lock\.json|pnpm-lock|yarn\.lock|requirements\.txt|go\.mod|cargo\.toml)/.test(path)
      ? 60
      : 0;
    const renameBoost = file.status === 'renamed' ? 20 : 0;
    return base + securityBoost + dependencyBoost + renameBoost;
  }

  private runDeterministicChecks(files: PrFile[], commits: PrCommit[]): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    const commitMessageCombined = commits.map((c) => c.message).join('\n').toLowerCase();
    const hasTestChanges = files.some((file) => /(test|spec)\./i.test(file.filename));

    for (const file of files) {
      const content = `${file.patch ?? ''}\n${file.filename}`.toLowerCase();

      if (/(password|secret|api[_-]?key|private[_-]?key)/.test(content)) {
        findings.push({
          severity: 'critical',
          file: file.filename,
          message: 'Potential hardcoded credential or secret exposure detected.',
          category: 'security',
        });
      }

      if (/(eval\(|new function\(|exec\(|child_process)/.test(content)) {
        findings.push({
          severity: 'warning',
          file: file.filename,
          message: 'Dynamic execution pattern detected; validate input safety and sandboxing.',
          category: 'security',
        });
      }

      if (/(\.map\(|\.forEach\(|for\s*\().{0,120}(await\s+)/s.test(content)) {
        findings.push({
          severity: 'warning',
          file: file.filename,
          message: 'Potential sequential async loop may impact performance for large inputs.',
          category: 'performance',
        });
      }

      if (
        /(package\.json|package-lock\.json|pnpm-lock|yarn\.lock|requirements\.txt|go\.mod|cargo\.toml)/.test(
          file.filename.toLowerCase(),
        )
      ) {
        findings.push({
          severity: 'suggestion',
          file: file.filename,
          message: 'Dependency changes detected; validate versions, vulnerability exposure, and license impact.',
          category: 'maintainability',
        });
      }

      if (file.status === 'renamed' && file.previousFilename) {
        findings.push({
          severity: 'info',
          file: file.filename,
          message: `File renamed from ${file.previousFilename}; verify imports and path-based references.`,
          category: 'correctness',
        });
      }

      if (file.deletions >= 120 && !hasTestChanges) {
        findings.push({
          severity: 'warning',
          file: file.filename,
          message: 'Large deletion without test updates detected; add regression coverage.',
          category: 'correctness',
        });
      }
    }

    if (/hotfix|quick fix|temp|temporary/.test(commitMessageCombined) && !hasTestChanges) {
      findings.push({
        severity: 'suggestion',
        file: 'commits',
        message: 'Commit history suggests urgent fixes; add targeted automated tests before merge.',
        category: 'maintainability',
      });
    }

    if (findings.length === 0 && !hasTestChanges) {
      findings.push({
        severity: 'info',
        file: 'global',
        message: 'No obvious issues detected, but consider adding tests for changed behavior.',
        category: 'maintainability',
      });
    }

    return findings;
  }

  private mergeFindings(primary: ReviewFinding[], secondary: ReviewFinding[]): ReviewFinding[] {
    const normalized = [...primary, ...secondary].map((item) => ({
      ...item,
      severity: ['critical', 'warning', 'suggestion', 'info'].includes(item.severity)
        ? item.severity
        : 'info',
      category: ['security', 'performance', 'correctness', 'style', 'maintainability'].includes(item.category)
        ? item.category
        : 'maintainability',
      file: item.file || 'unknown',
      message: item.message || 'Issue detected',
    }));
    const dedup = new Map<string, ReviewFinding>();
    for (const finding of normalized) {
      const key = `${finding.file}|${finding.category}|${finding.message}`;
      if (!dedup.has(key)) dedup.set(key, finding);
    }
    return [...dedup.values()].slice(0, 80);
  }

  private computeScore(baseScore: number, findings: ReviewFinding[]): number {
    const penalties: Record<ReviewFinding['severity'], number> = {
      critical: 25,
      warning: 10,
      suggestion: 4,
      info: 1,
    };
    const totalPenalty = findings.reduce((acc, finding) => acc + penalties[finding.severity], 0);
    return Math.max(0, Math.min(100, Math.round(baseScore - totalPenalty)));
  }

  private resolveRecommendation(
    modelRecommendation: unknown,
    findings: ReviewFinding[],
    score: number,
  ): 'approve' | 'request_changes' | 'comment' {
    const hasCritical = findings.some((finding) => finding.severity === 'critical');
    if (hasCritical || score < 55) return 'request_changes';
    if (score >= 85) return 'approve';
    if (
      modelRecommendation === 'approve' ||
      modelRecommendation === 'request_changes' ||
      modelRecommendation === 'comment'
    ) {
      return modelRecommendation;
    }
    return 'comment';
  }

  private extractIssueReferences(text: string): number[] {
    const matches = text.match(/#(\d+)/g) ?? [];
    return matches
      .map((match) => Number(match.replace('#', '')))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 20);
  }

  private async getHistoricalReviewPatterns(repo: string): Promise<HistoricalReviewPatterns> {
    const records = await this.prReviewRepository.find({
      where: { repo },
      order: { createdAt: 'DESC' },
      take: 80,
    });

    if (records.length === 0) {
      return {
        totalReviews: 0,
        avgScore: null,
        commonCategories: [],
        recentFailureRate: 0,
      };
    }

    const scoreValues = records
      .map((record) => Number((record.findings as any)?.score))
      .filter((value) => !isNaN(value));
    const avgScore = scoreValues.length > 0
      ? Math.round(scoreValues.reduce((acc, value) => acc + value, 0) / scoreValues.length)
      : null;

    const categoryCount = new Map<string, number>();
    for (const record of records) {
      const items = Array.isArray((record.findings as any)?.items)
        ? (record.findings as any).items
        : Array.isArray(record.findings)
          ? record.findings
          : [];
      for (const item of items) {
        const key = typeof item?.category === 'string' ? item.category : 'maintainability';
        categoryCount.set(key, (categoryCount.get(key) ?? 0) + 1);
      }
    }

    const recentFailures = records.slice(0, 20).filter((record) => record.status === 'failed').length;
    const recentFailureRate = Math.round((recentFailures / Math.max(1, Math.min(records.length, 20))) * 100);

    return {
      totalReviews: records.length,
      avgScore,
      commonCategories: [...categoryCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name]) => name),
      recentFailureRate,
    };
  }

  private formatReviewComment(
    analysis: {
      summary: string;
      findings: ReviewFinding[];
      score: number;
      recommendation: 'approve' | 'request_changes' | 'comment';
    },
    prInfo: PrInfo,
  ): string {
    const emoji = analysis.score >= 80 ? '✅' : analysis.score >= 60 ? '⚠️' : '❌';
    const recLabel: Record<string, string> = {
      approve: '✅ Approve',
      request_changes: '❌ Request Changes',
      comment: '💬 Comment',
    };

    const lines: string[] = [
      `## 🤖 CodeRover Review`,
      '',
      `${emoji} **Score: ${analysis.score}/100** | **${recLabel[analysis.recommendation] ?? analysis.recommendation}**`,
      '',
      `### Summary`,
      analysis.summary,
      '',
    ];

    if (analysis.findings.length > 0) {
      lines.push('### Findings');
      lines.push('');

      const grouped: Record<string, ReviewFinding[]> = {};
      for (const f of analysis.findings) {
        if (!grouped[f.severity]) grouped[f.severity] = [];
        grouped[f.severity].push(f);
      }

      const severityOrder = ['critical', 'warning', 'suggestion', 'info'];
      const severityEmoji: Record<string, string> = {
        critical: '🔴',
        warning: '🟡',
        suggestion: '🔵',
        info: 'ℹ️',
      };

      for (const sev of severityOrder) {
        if (!grouped[sev]?.length) continue;
        lines.push(`**${severityEmoji[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)}**`);
        for (const f of grouped[sev]) {
          const location = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
          lines.push(`- ${location} — ${f.message} *(${f.category})*`);
        }
        lines.push('');
      }
    } else {
      lines.push('### Findings');
      lines.push('No issues found. ✨');
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated by CodeRover for PR [#${prInfo.number}](${prInfo.url})*`);

    return lines.join('\n');
  }

  /**
   * Phase 10 B2 — persist one `pr_review_findings` row per finding item.
   *
   * Classification:
   *   - Finding key matches the deterministic set (runDeterministicChecks +
   *     graph-rag helpers) → `producerKind = 'ast'`, tagger returns
   *     EXTRACTED / score 1.0.
   *   - Otherwise it originated from the AI analysis. The model does not
   *     currently return a per-finding confidence, so `selfScore` is `null`
   *     and the tagger downgrades to AMBIGUOUS. When the PR-review prompt
   *     starts asking the model to self-rate, pass that number here and
   *     INFERRED will flow naturally.
   */
  private async writePrReviewFindings(
    prReviewId: string,
    orgId: string | null,
    items: ReviewFinding[],
    deterministicKeys: Set<string>,
  ): Promise<void> {
    if (!Array.isArray(items) || items.length === 0) return;

    const rows: Partial<PrReviewFinding>[] = items.map((item) => {
      const isDeterministic = deterministicKeys.has(findingKey(item));
      const producerLabel = isDeterministic
        ? 'pr-review:deterministic'
        : 'pr-review:ai';
      const evidence = this.confidenceTagger.tag({
        producer: producerLabel,
        producerKind: isDeterministic ? 'ast' : 'llm',
        // AI does not report a per-finding confidence today → falls through
        // to AMBIGUOUS. Plumb the model's score here when the prompt
        // starts returning one.
        selfScore: null,
        refs: {
          source: isDeterministic ? 'deterministic' : 'ai',
          severity: item.severity,
          category: item.category,
          model: this.chatModel,
        },
      });

      return {
        prReviewId,
        orgId,
        file: item.file ?? null,
        line: typeof item.line === 'number' ? item.line : null,
        title: truncate(item.message, 140),
        body: item.message,
        severity: mapReviewSeverity(item.severity),
        category: item.category,
        confidence: evidence.tag,
        confidenceScore: evidence.score,
        evidenceRef: evidence.evidence_ref as any,
        producer: producerLabel,
      };
    });

    await this.findingRepository.insert(rows);
  }
}

/**
 * Dedup / lookup key for a review finding. Must match the key used in
 * `mergeFindings` so the deterministic-origin check can recognize merged
 * items that came from both sources.
 */
function findingKey(finding: ReviewFinding): string {
  return `${finding.file}|${finding.category}|${finding.message}`;
}

/**
 * Map the in-service severity vocabulary (`critical|warning|suggestion|info`)
 * to the `pr_review_findings` column vocabulary (`critical|high|medium|low`).
 * Kept private so external callers never depend on the mapping.
 */
function mapReviewSeverity(severity: ReviewFinding['severity']): FindingSeverity {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'warning':
      return 'high';
    case 'suggestion':
      return 'medium';
    case 'info':
      return 'low';
    default:
      return 'low';
  }
}

function truncate(value: string, max: number): string {
  if (typeof value !== 'string') return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
