import { Injectable, Logger, ConflictException, NotFoundException, OnModuleInit, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Repo } from '../entities/repo.entity';
import { SyncLog } from '../entities/sync-log.entity';
import { CodeChunk } from '../entities/code-chunk.entity';
import { RegisterRepoDto } from './dto/register-repo.dto';
import { UpdateRepoDto } from './dto/update-repo.dto';
import { GitHubService } from '../ingest/github.service';
import { MemgraphService } from '../graph/memgraph.service';
import { currentOrgId } from '../organizations/org-context';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RepoService implements OnModuleInit {
  private readonly logger = new Logger(RepoService.name);

  constructor(
    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepository: Repository<SyncLog>,
    @InjectRepository(CodeChunk)
    private readonly codeChunkRepository: Repository<CodeChunk>,
    private readonly githubService: GitHubService,
    private readonly memgraphService: MemgraphService,
  ) {}

  async onModuleInit() {
    await this.loadConfig();
  }

  private async loadConfig() {
    const configPath = path.resolve(process.cwd(), 'coderover.config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.repo) {
          this.logger.log(`Found coderover.config.json, ensuring repo: ${config.repo}`);
          await this.ensureRepo(config.repo, config.branch);
        }
      } catch (err) {
        this.logger.error(`Failed to load coderover.config.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Parse repoUrl — accepts "owner/name" or full GitHub URL */
  private parseRepoUrl(repoUrl: string): { owner: string; name: string; fullName: string } {
    let fullName = repoUrl.trim();

    // Strip GitHub URL prefix
    const urlMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (urlMatch) {
      fullName = `${urlMatch[1]}/${urlMatch[2]}`;
    }

    // Remove trailing .git and trailing slashes
    fullName = fullName.replace(/\.git$/, '').replace(/\/+$/, '');

    const parts = fullName.split('/').filter((p) => !!p);
    if (parts.length < 2) {
      throw new Error(`Invalid repo format: ${repoUrl}. Expected "owner/name" or full GitHub URL.`);
    }

    const owner = parts[parts.length - 2];
    const name = parts[parts.length - 1];
    const finalFullName = `${owner}/${name}`;

    return { owner, name, fullName: finalFullName };
  }

  async ensureRepo(fullName: string, branch?: string, token?: string): Promise<Repo> {
    let repoEntity = await this.repoRepository.findOne({ where: { fullName } });
    
    if (!repoEntity) {
      repoEntity = await this.repoRepository.findOne({ where: { fullName: ILike(fullName) } });
    }

    if (!repoEntity) {
      const { owner, name, fullName: parsedName } = this.parseRepoUrl(fullName);
      const info = await this.githubService.detectRepoInfo(parsedName, token);
      const branchName = branch?.trim() || 'main';
      
      repoEntity = await this.repoRepository.save(
        this.repoRepository.create({
          owner,
          name,
          fullName: parsedName,
          branch: branchName,
          language: info.language,
          fileCount: info.fileCount,
          isActive: true,
          githubToken: token,
          orgId: currentOrgId() ?? null,
        } as Partial<Repo>),
      );
      this.logger.log(`Ensured repo exists: ${parsedName}`);
    } else {
      let changed = false;

      if (!repoEntity.isActive) {
        repoEntity.isActive = true;
        changed = true;
      }

      if (branch && repoEntity.branch !== branch) {
        repoEntity.branch = branch;
        changed = true;
      }

      if (changed) {
        await this.repoRepository.save(repoEntity);
      }
    }

    return repoEntity;
  }

  async getDefaultRepo(): Promise<Repo | null> {
    const repos = await this.repoRepository.find({ 
        where: { isActive: true }, 
        order: { createdAt: 'ASC' },
        take: 1 
    });
    return repos.length > 0 ? repos[0] : null;
  }

  async register(dto: RegisterRepoDto): Promise<Repo> {
    const { owner, name, fullName } = this.parseRepoUrl(dto.repoUrl);
    const branchInput = dto.branch?.trim();
    const branchName = branchInput || 'main';

    // Phase 10 (2026-04-16): OAuth-backed registration passes
    // connectedByUserId; the manual "Advanced" form passes githubToken.
    // They're mutually exclusive — if both are present, connectedByUserId
    // wins and the PAT is discarded so we don't end up with a stale token.
    const oauthOwner = dto.connectedByUserId?.trim() || null;
    const manualPat = oauthOwner ? null : dto.githubToken?.trim() || null;

    // For detectRepoInfo we need a token now — prefer the caller's inputs,
    // fall back to env.
    const detectToken =
      manualPat ||
      (oauthOwner
        ? (await this.tokenResolverForOauth(oauthOwner))
        : undefined);

    // Check for existing repo
    let existing = await this.repoRepository.findOne({ where: { fullName } });
    if (!existing) {
      existing = await this.repoRepository.findOne({ where: { fullName: ILike(fullName) } });
    }
    if (existing) {
      if (existing.isActive) {
        throw new ConflictException(`Repository ${fullName} is already registered`);
      }

      existing.owner = owner;
      existing.name = name;
      existing.isActive = true;
      if (oauthOwner) {
        existing.connectedByUserId = oauthOwner;
        existing.githubToken = null as unknown as string; // clear stale PAT
      } else if (dto.githubToken !== undefined) {
        existing.githubToken = manualPat || ('' as string);
        existing.connectedByUserId = null;
      }
      if (dto.branch !== undefined) {
        existing.branch = branchName;
      }
      if (dto.label !== undefined) {
        existing.label = dto.label?.trim() || '';
      }

      const reactivated = await this.repoRepository.save(existing);
      this.logger.log(`Reactivated repo: ${fullName}`);
      return reactivated;
    }

    // Detect repo info from GitHub
    const info = await this.githubService.detectRepoInfo(fullName, detectToken);

    const repo = this.repoRepository.create({
      owner,
      name,
      fullName,
      githubToken: manualPat,
      connectedByUserId: oauthOwner,
      branch: branchName,
      label: dto.label?.trim() || null,
      language: info.language,
      fileCount: info.fileCount,
      isActive: true,
      orgId: currentOrgId() ?? null,
    } as Partial<Repo>);

    const saved = await this.repoRepository.save(repo);
    this.logger.log(
      `Registered repo: ${fullName} (${info.language}, ${info.fileCount} files, source=${oauthOwner ? 'oauth' : manualPat ? 'manual' : 'env'})`,
    );
    return saved;
  }

  /**
   * Local helper: resolve an OAuth-connected user's access token for the
   * narrow case of `register()` where we need the token BEFORE creating
   * the Repo row (to call `detectRepoInfo`). After save, the live
   * resolution flows through `GitHubTokenResolver` on every subsequent
   * API call. Avoids a circular dep on GitHubIntegrationModule.
   */
  private async tokenResolverForOauth(userId: string): Promise<string | undefined> {
    const row = await this.repoRepository.manager.query(
      `SELECT access_token FROM github_connections WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    return row?.[0]?.access_token || undefined;
  }

  async updateConfig(id: string, dto: UpdateRepoDto): Promise<Repo> {
    const repo = await this.findById(id);

    if (dto.branch !== undefined) {
      repo.branch = dto.branch.trim() || 'main';
    }

    if (dto.label !== undefined) {
      repo.label = dto.label.trim() || '';
    }

    if (dto.githubToken !== undefined) {
      repo.githubToken = dto.githubToken.trim() || '';
    }

    if (typeof dto.isActive === 'boolean') {
      repo.isActive = dto.isActive;
    }

    const updated = await this.repoRepository.save(repo);
    this.logger.log(`Updated repo config: ${updated.fullName}`);
    return updated;
  }

  async findAll(): Promise<Repo[]> {
    // Phase 9 (security fix 2026-04-15): fail closed when orgId is missing.
    // Previously fell back to unscoped reads, enabling cross-tenant data
    // leakage via tokens without an orgId claim.
    const orgId = currentOrgId();
    if (!orgId) {
      throw new ForbiddenException('Organization scope required');
    }
    return this.repoRepository.find({ where: { isActive: true, orgId } });
  }

  async findById(id: string): Promise<Repo> {
    const repo = await this.repoRepository.findOne({ where: { id } });
    if (!repo) {
      throw new NotFoundException(`Repo ${id} not found`);
    }
    return repo;
  }

  async findByFullName(fullName: string): Promise<Repo | null> {
    return this.repoRepository.findOne({ where: { fullName } });
  }

  async deactivate(id: string): Promise<void> {
    const repo = await this.findById(id);
    repo.isActive = false;
    await this.repoRepository.save(repo);
    
    // Clear associated data to ensure a fresh sync if reactivated
    await this.cleanupRepoData(id);
    
    this.logger.log(`Deactivated repo: ${repo.fullName} and cleared indexed data`);
  }

  async delete(id: string): Promise<void> {
    const repo = await this.findById(id);
    
    // Clear associated data first
    await this.cleanupRepoData(id);
    
    await this.repoRepository.remove(repo);
    this.logger.log(`Deleted repo: ${repo.fullName} and cleared indexed data`);
  }

  /**
   * Clears all indexed data for a repository (SyncLog, CodeChunks, Graph nodes).
   */
  private async cleanupRepoData(repoId: string): Promise<void> {
    this.logger.log(`Cleaning up indexed data for repoId: ${repoId}`);
    try {
      // 1. Clear SyncLog
      await this.syncLogRepository.delete({ repoId });
      
      // 2. Clear CodeChunks
      await this.codeChunkRepository.delete({ repoId });
      
      // 3. Clear Memgraph data
      await this.memgraphService.clearRepoData(repoId);
      
      this.logger.log(`Successfully cleaned up data for repoId: ${repoId}`);
    } catch (error) {
      this.logger.error(`Failed to cleanup data for repoId: ${repoId}`, error);
    }
  }

  async buildSystemPrompt(repoIds: string[]): Promise<string> {
    const toolInstructions = `
You have access to code intelligence tools that can search the indexed codebase:
- search_codebase: Semantic + keyword hybrid search across code chunks. Use this to find specific files, functions, patterns, or concepts.
- find_symbol: Look up a specific symbol (class, function, interface) by name.
- get_module_summary: Get all code in a specific module.
- get_api_endpoints: Extract REST API endpoints from controller code.
- find_dependencies: Find files that import a given path.
- graph_analysis: Analyze dependency graph (cycles, hotspots, impact analysis).
- query_code_graph: Run Cypher queries against the code dependency graph.

IMPORTANT INSTRUCTIONS:
- When code context is provided below, USE IT FIRST to answer the question before calling tools.
- Only call tools if the provided context is insufficient or the user asks about something not covered.
- Always cite specific file paths and line numbers when referencing code.
- When you use a tool, pass the repoId parameter to scope results to the correct repository.`;

    if (!repoIds || repoIds.length === 0) {
      return `You are an AI code assistant for the CodeRover platform.
${toolInstructions}`;
    }

    const repos = await Promise.all(repoIds.map((id) => this.findById(id)));

    if (repos.length === 1) {
      const r = repos[0];
      return `You are an AI assistant with deep knowledge of the ${r.label ?? r.fullName} codebase.
Repository: ${r.fullName} | Language: ${r.language} | Branch: ${r.branch} | Files indexed: ${r.fileCount} | Repository ID: ${r.id}
${toolInstructions}
When using tools, always pass repoId="${r.id}" to scope searches to this repository.
Answer questions about this codebase with precision. When generating code, follow the patterns found in the existing codebase.`;
    }

    const repoList = repos
      .map((r) => `- ${r.label ?? r.fullName} (${r.language}, ${r.fileCount} files, repoId: ${r.id})`)
      .join('\n');

    return `You are an AI assistant with access to ${repos.length} indexed codebases for cross-repo analysis.
Repositories:
${repoList}
${toolInstructions}
Use search_codebase with the appropriate repoId to query each repo independently. For integration questions, search both repos and synthesize the answer. Always cite file paths with repo names.`;
  }
}
