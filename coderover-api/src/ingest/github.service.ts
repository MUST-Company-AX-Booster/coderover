import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import * as crypto from 'crypto';

export interface PrFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes?: number;
  patch?: string;
}

export interface PrInfo {
  number: number;
  title: string;
  body: string | null;
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
  author: string;
  url: string;
  state: string;
}

export interface PrCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface RelatedIssueOrPr {
  number: number;
  type: 'issue' | 'pull_request';
  title: string;
  state: string;
  url: string;
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);

  constructor(private readonly configService: ConfigService) {}

  /** Create an Octokit instance — uses per-repo token when provided, otherwise falls back to global GITHUB_TOKEN */
  getOctokit(token?: string): Octokit {
    const resolvedToken = (token && token.trim()) || this.configService.get<string>('GITHUB_TOKEN');
    return new Octokit({
      auth: resolvedToken || undefined,
    });
  }

  /** Parse "owner/repo" string into owner and repo parts */
  parseRepo(repo: string): { owner: string; repo: string } {
    const parts = repo.split('/').filter((p) => !!p);
    if (parts.length < 2) {
      this.logger.error(`Invalid repo format: ${repo}`);
      throw new Error(`Invalid repo format: ${repo}. Expected "owner/name"`);
    }
    const owner = parts[parts.length - 2];
    const repoName = parts[parts.length - 1];
    return { owner, repo: repoName };
  }

  /** Detect basic repo info from GitHub (default branch, language, file count) */
  async detectRepoInfo(
    fullName: string,
    token?: string,
  ): Promise<{ defaultBranch: string; language: string; fileCount: number }> {
    const octokit = this.getOctokit(token);
    const { owner, repo } = this.parseRepo(fullName);

    const { data } = await octokit.repos.get({ owner, repo });
    const defaultBranch = data.default_branch;
    const language = data.language ?? 'Unknown';

    const { data: branchData } = await octokit.repos.getBranch({
      owner,
      repo,
      branch: defaultBranch,
    });
    const treeSha = branchData.commit.commit.tree.sha;
    const { data: treeData } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      recursive: '1',
    });
    const fileCount = treeData.tree.filter((item) => item.type === 'blob').length;

    this.logger.log(`Detected repo info for ${fullName}: branch=${defaultBranch}, lang=${language}, files=${fileCount}`);
    return { defaultBranch, language, fileCount };
  }

  /** Get the latest commit SHA for a given branch */
  async getLatestCommitSha(repo: string, branch: string, token?: string): Promise<string> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    this.logger.debug(`Fetching branch info: ${owner}/${repoName}@${branch}`);
    const { data } = await octokit.repos.getBranch({
      owner,
      repo: repoName,
      branch,
    });

    this.logger.debug(`Latest commit on ${repo}/${branch}: ${data.commit.sha}`);
    return data.commit.sha;
  }

  async getDefaultBranch(repo: string, token?: string): Promise<string> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);
    
    this.logger.debug(`Fetching default branch for ${owner}/${repoName}`);
    const { data } = await octokit.repos.get({ owner, repo: repoName });
    return data.default_branch;
  }

  /**
   * Get list of files changed between two commits.
   */
  async getChangedFiles(repo: string, since: string, until: string, token?: string): Promise<string[]> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data } = await octokit.repos.compareCommits({
      owner,
      repo: repoName,
      base: since,
      head: until,
    });

    const files = (data.files || [])
      .filter((f) => f.status !== 'removed')
      .map((f) => f.filename);

    this.logger.debug(`Changed files between ${since.slice(0, 7)}..${until.slice(0, 7)}: ${files.length}`);
    return files;
  }

  /**
   * Get all files in a repository using recursive tree walk.
   */
  async getAllFiles(repo: string, branch: string, token?: string): Promise<string[]> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data: branchData } = await octokit.repos.getBranch({
      owner,
      repo: repoName,
      branch,
    });
    const treeSha = branchData.commit.commit.tree.sha;

    const { data } = await octokit.git.getTree({
      owner,
      repo: repoName,
      tree_sha: treeSha,
      recursive: '1',
    });

    const files = data.tree
      .filter((item) => item.type === 'blob' && item.path)
      .map((item) => item.path as string);

    this.logger.log(`Total files in ${repo}/${branch}: ${files.length}`);
    return files;
  }

  /**
   * Get the content of a single file from the repository.
   */
  async getFileContent(repo: string, filePath: string, ref: string, token?: string): Promise<string> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data } = await octokit.repos.getContent({
      owner,
      repo: repoName,
      path: filePath,
      ref,
    });

    if ('content' in data && data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      return decoded;
    }

    throw new Error(`No content found for ${filePath} at ref ${ref}`);
  }

  // ─── Phase 4: PR Integration ────────────────────────────────────────────────

  /**
   * Get metadata for a pull request.
   */
  async getPrInfo(repo: string, prNumber: number, token?: string): Promise<PrInfo> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data } = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      headBranch: data.head.ref,
      baseBranch: data.base.ref,
      author: data.user?.login ?? 'unknown',
      url: data.html_url,
      state: data.state,
    };
  }

  /**
   * Get files changed in a PR along with their diffs.
   */
  async getPrFiles(repo: string, prNumber: number, token?: string): Promise<PrFile[]> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);
    const files: PrFile[] = [];
    let page = 1;

    while (true) {
      const { data } = await octokit.pulls.listFiles({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
        page,
      });

      files.push(
        ...data.map((f) => ({
          filename: f.filename,
          previousFilename: f.previous_filename ?? undefined,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch,
        })),
      );

      if (data.length < 100) break;
      page += 1;
      if (page > 10) break;
    }

    return files;
  }

  async getPrCommits(repo: string, prNumber: number, token?: string): Promise<PrCommit[]> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);
    const commits: PrCommit[] = [];
    let page = 1;

    while (true) {
      const { data } = await octokit.pulls.listCommits({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100,
        page,
      });

      commits.push(
        ...data.map((item) => ({
          sha: item.sha,
          message: item.commit.message,
          author: item.commit.author?.name ?? item.author?.login ?? 'unknown',
          date: item.commit.author?.date ?? new Date().toISOString(),
        })),
      );

      if (data.length < 100) break;
      page += 1;
      if (page > 5) break;
    }

    return commits;
  }

  async getRelatedIssuesAndPrs(
    repo: string,
    references: number[],
    token?: string,
  ): Promise<RelatedIssueOrPr[]> {
    if (references.length === 0) return [];
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);
    const uniqueRefs = [...new Set(references)].slice(0, 15);
    const results: RelatedIssueOrPr[] = [];

    for (const issueNumber of uniqueRefs) {
      try {
        const { data } = await octokit.issues.get({
          owner,
          repo: repoName,
          issue_number: issueNumber,
        });

        results.push({
          number: data.number,
          type: data.pull_request ? 'pull_request' : 'issue',
          title: data.title,
          state: data.state,
          url: data.html_url,
        });
      } catch (error) {
        this.logger.debug(
          `Could not load related issue/PR #${issueNumber} for ${repo}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return results;
  }

  async getRepositoryStructure(repo: string, branch: string, token?: string): Promise<string[]> {
    const files = await this.getAllFiles(repo, branch, token);
    return files.slice(0, 400);
  }

  /**
   * Post a review comment on a pull request (top-level comment on the PR itself).
   * Returns the comment id and html_url.
   */
  async postPrReviewComment(
    repo: string,
    prNumber: number,
    body: string,
    token?: string,
  ): Promise<{ commentId: number; url: string }> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data } = await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body,
    });

    this.logger.log(`Posted PR review comment on ${repo}#${prNumber}: ${data.html_url}`);
    return { commentId: data.id, url: data.html_url };
  }

  /**
   * Create a structured PR review (APPROVE/REQUEST_CHANGES/COMMENT).
   */
  async createPrReview(
    repo: string,
    prNumber: number,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    token?: string,
  ): Promise<{ reviewId: number; url: string }> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data } = await octokit.pulls.createReview({
      owner,
      repo: repoName,
      pull_number: prNumber,
      body,
      event,
    });

    this.logger.log(`Posted PR review on ${repo}#${prNumber}: ${data.html_url}`);
    return { reviewId: data.id, url: data.html_url };
  }

  /**
   * Create a new branch from a base SHA.
   */
  async createBranch(
    repo: string,
    newBranchName: string,
    baseSha: string,
    token?: string,
  ): Promise<void> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    await octokit.git.createRef({
      owner,
      repo: repoName,
      ref: `refs/heads/${newBranchName}`,
      sha: baseSha,
    });

    this.logger.log(`Created branch ${newBranchName} on ${repo} from ${baseSha}`);
  }

  async createOrUpdateFile(
    repo: string,
    filePath: string,
    branch: string,
    content: string,
    commitMessage: string,
    token?: string,
  ): Promise<{ path: string; sha: string }> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    let sha: string | undefined;
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: filePath,
        ref: branch,
      });
      if (!Array.isArray(data) && 'sha' in data) {
        sha = data.sha;
      }
    } catch (err) {
      const status = (err as any)?.status;
      if (status !== 404) throw err;
    }

    const { data: updated } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: filePath,
      message: commitMessage,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      sha,
    });

    const updatedSha = Array.isArray(updated.content) ? '' : updated.content?.sha;
    if (!updatedSha) {
      throw new Error(`GitHub did not return updated file SHA for ${repo}:${filePath}@${branch}`);
    }

    return { path: filePath, sha: updatedSha };
  }

  async createPullRequest(
    repo: string,
    title: string,
    headBranch: string,
    baseBranch: string,
    body: string,
    token?: string,
  ): Promise<{ number: number; url: string }> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    const octokit = this.getOctokit(token);

    const { data } = await octokit.pulls.create({
      owner,
      repo: repoName,
      title,
      head: headBranch,
      base: baseBranch,
      body,
    });

    return { number: data.number, url: data.html_url };
  }

  /**
   * Verify a GitHub webhook HMAC-SHA256 signature.
   * Returns true if valid, false otherwise.
   */
  verifyWebhookSignature(payload: Buffer, signature: string, secret: string): boolean {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}
