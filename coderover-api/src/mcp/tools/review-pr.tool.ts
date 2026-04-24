import { Injectable } from '@nestjs/common';
import { MCPTool, MCPToolParameter } from './index';
import { PrReviewService } from '../../pr-review/pr-review.service';

@Injectable()
export class ReviewPrTool implements MCPTool {
  readonly name = 'review_pull_request';
  readonly description =
    'Run an AI code review on a GitHub pull request. Analyses the diff, identifies issues by severity, and returns a structured review with findings, a score, and a recommendation. Optionally posts the review as a comment on the PR.';

  readonly parameters: MCPToolParameter[] = [
    {
      name: 'repo',
      type: 'string',
      description: 'Repository full name, e.g. "owner/repo-name"',
      required: true,
    },
    {
      name: 'prNumber',
      type: 'number',
      description: 'Pull request number',
      required: true,
    },
    {
      name: 'postComment',
      type: 'boolean',
      description: 'Whether to post the review as a GitHub comment (default: false for MCP calls)',
      required: false,
    },
    {
      name: 'repoId',
      type: 'string',
      description: 'Optional UUID of the registered repo (used to look up the GitHub token)',
      required: false,
    },
  ];

  constructor(private readonly prReviewService: PrReviewService) {}

  async execute(args: Record<string, any>): Promise<any> {
    const repo = args.repo as string;
    const prNumber = Number(args.prNumber);
    const postComment = args.postComment === true; // default false for MCP calls
    const repoId = args.repoId as string | undefined;

    if (!repo || !prNumber || isNaN(prNumber)) {
      return {
        ok: false,
        error: 'repo (string) and prNumber (number) are required',
      };
    }

    const result = await this.prReviewService.reviewPullRequest(repo, prNumber, {
      postComment,
      repoId,
    });

    return {
      ok: true,
      ...result,
    };
  }
}
