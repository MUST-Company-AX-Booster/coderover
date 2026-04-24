import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  Res,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
  Query,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { Repo } from '../entities/repo.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrReviewService } from './pr-review.service';
import { GitHubService } from '../ingest/github.service';

@ApiTags('pr-review')
@Controller()
export class PrReviewController {
  private readonly logger = new Logger(PrReviewController.name);

  constructor(
    private readonly prReviewService: PrReviewService,
    private readonly githubService: GitHubService,
    private readonly configService: ConfigService,

    @InjectQueue('ingest')
    private readonly ingestQueue: Queue,

    @InjectQueue('agent-pr-review')
    private readonly agentQueue: Queue,

    @InjectQueue('agent-health')
    private readonly healthQueue: Queue,

    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,
  ) {}

  // ─── GitHub Webhook ─────────────────────────────────────────────────────────

  /**
   * POST /webhooks/github
   *
   * Receives all GitHub webhook events (push, pull_request, ping, etc.).
   * HMAC-SHA256 signature is verified when GITHUB_WEBHOOK_SECRET is set.
   *
   * push events → trigger incremental repo re-index
   * pull_request (opened/synchronize) → trigger AI PR review
   * ping → acknowledge
   */
  @Post('webhooks/github')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive GitHub webhook events for ingest and PR review automation' })
  @ApiHeader({
    name: 'x-github-event',
    required: true,
    description: 'GitHub webhook event type',
    example: 'pull_request',
  })
  @ApiHeader({
    name: 'x-hub-signature-256',
    required: false,
    description: 'GitHub HMAC signature when webhook secret is enabled',
    example: 'sha256=ab12cd34...',
  })
  @ApiBody({
    description: 'GitHub webhook payload',
    schema: {
      example: {
        action: 'opened',
        repository: { full_name: 'demo/codebase', default_branch: 'main' },
        pull_request: { number: 24 },
      },
    },
  })
  @ApiOkResponse({
    description: 'Webhook event accepted and processed',
    schema: {
      examples: {
        ping: { value: { ok: true, message: 'pong', zen: 'Keep it logically awesome.' } },
        push: { value: { ok: true, message: 'Ingest queued for demo/codebase' } },
        pr: { value: { ok: true, message: 'PR review started for demo/codebase#24' } },
      },
    },
  })
  async handleGitHubWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-github-event') eventType: string,
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: any,
  ): Promise<void> {
    this.logger.log(`GitHub webhook: ${eventType} for ${body?.repository?.full_name ?? 'unknown'}`);

    // ── Signature verification ────────────────────────────────────────────────
    const secret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET');
    if (secret) {
      // Get raw body (set by RawBodyMiddleware)
      const rawBody: Buffer = (req as any).rawBody;
      if (!rawBody || !signature) {
        this.logger.warn('Missing raw body or signature for webhook verification');
        res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Missing signature' });
        return;
      }

      const isValid = this.githubService.verifyWebhookSignature(rawBody, signature, secret);
      if (!isValid) {
        this.logger.warn('Invalid webhook signature');
        res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Invalid signature' });
        return;
      }
    }

    // ── Log event ─────────────────────────────────────────────────────────────
    const event = await this.prReviewService.logWebhookEvent(eventType ?? 'unknown', body);

    // ── Handle ping ───────────────────────────────────────────────────────────
    if (eventType === 'ping') {
      await this.prReviewService.markEventProcessed(event.id);
      res.json({ ok: true, message: 'pong', zen: body?.zen ?? '' });
      return;
    }

    // ── Handle push → trigger incremental ingest ──────────────────────────────
    if (eventType === 'push') {
      const repoFullName: string = body?.repository?.full_name;
      const ref: string = body?.ref ?? '';
      const afterSha: string = body?.after ?? '';

      // Skip branch deletions (after = 0000...0000)
      if (!afterSha || afterSha === '0000000000000000000000000000000000000000') {
        await this.prReviewService.markEventProcessed(event.id);
        res.json({ ok: true, message: 'Branch deletion ignored' });
        return;
      }

      const defaultBranch = body?.repository?.default_branch ?? 'main';
      const pushedBranch = ref.replace('refs/heads/', '');

      if (pushedBranch !== defaultBranch) {
        this.logger.debug(`Push on non-default branch ${pushedBranch} — skipping auto-reindex`);
        await this.prReviewService.markEventProcessed(event.id);
        res.json({ ok: true, message: `Branch ${pushedBranch} not default — skipped` });
        return;
      }

      // Enqueue incremental ingest (not force — only changed files)
      try {
        await this.ingestQueue.add('trigger-ingest', {
          repo: repoFullName,
          branch: defaultBranch,
          forceReindex: false,
        });

        try {
          const repoEntity = await this.repoRepository.findOne({ where: { fullName: ILike(repoFullName) } });
          const repoConfig = repoEntity?.agentConfig as any;
          const scanOnPush =
            this.configService.get<string>('AGENT_SCAN_ON_PUSH') === 'true' || repoConfig?.scan_on_push === true;

          if (repoEntity && scanOnPush) {
            await this.healthQueue.add(
              'check-repo',
              { repoId: repoEntity.id },
              { removeOnComplete: true },
            );
            this.logger.log(`Queued agent health scan for ${repoFullName} after push`);
          }
        } catch (err) {
          this.logger.debug(
            `Agent health scan not queued for ${repoFullName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        await this.prReviewService.markEventProcessed(event.id);
        this.logger.log(`Queued incremental ingest for ${repoFullName} after push`);
        res.json({ ok: true, message: `Ingest queued for ${repoFullName}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.prReviewService.markEventProcessed(event.id, msg);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ ok: false, error: msg });
      }
      return;
    }

    // ── Handle pull_request ───────────────────────────────────────────────────
    if (eventType === 'pull_request') {
      const action: string = body?.action;
      const prNumber: number = body?.pull_request?.number;
      const repoFullName: string = body?.repository?.full_name;

      // Only review on open/synchronize
      if (!['opened', 'synchronize', 'reopened'].includes(action)) {
        await this.prReviewService.markEventProcessed(event.id);
        res.json({ ok: true, message: `PR action ${action} — skipped` });
        return;
      }

      // Check Agent Feature Gate
      const agentEnabled = this.configService.get<string>('AGENT_PR_ENABLED') === 'true';
      if (agentEnabled) {
        const repoEntity = await this.repoRepository.findOne({ where: { fullName: ILike(repoFullName) } });
        const repoConfig = repoEntity?.agentConfig as any;

        if (repoEntity && repoConfig?.pr_review_enabled) {
          await this.agentQueue.add('review', {
            repoId: repoEntity.id,
            repoFullName,
            prNumber,
            trigger: 'webhook',
          });
          await this.prReviewService.markEventProcessed(event.id);
          this.logger.log(`Queued agent PR review for ${repoFullName}#${prNumber}`);
          res.json({ ok: true, message: `Agent PR review queued for ${repoFullName}#${prNumber}` });
          return;
        }
      }

      // Fire-and-forget: run review asynchronously so webhook responds quickly
      this.runPrReviewAsync(repoFullName, prNumber, event.id);

      res.json({ ok: true, message: `PR review started for ${repoFullName}#${prNumber}` });
      return;
    }

    // ── Unknown event ─────────────────────────────────────────────────────────
    await this.prReviewService.markEventProcessed(event.id);
    res.json({ ok: true, message: `Event ${eventType} acknowledged` });
  }

  // ─── Manual PR Review ───────────────────────────────────────────────────────

  /**
   * POST /pr-review/trigger
   * Manually trigger a PR review (JWT protected).
   */
  @Post('pr-review/trigger')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Manually trigger AI PR review' })
  @ApiBody({
    schema: {
      example: {
        repo: 'demo/codebase',
        prNumber: 24,
        postComment: true,
        repoId: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
      },
    },
  })
  @ApiOkResponse({
    description: 'PR review result',
    schema: {
      example: {
        repo: 'demo/codebase',
        prNumber: 24,
        summary: 'Found 3 issues and 2 improvements',
        postedComment: true,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async triggerReview(
    @Body() body: { repo: string; prNumber: number; postComment?: boolean; repoId?: string },
  ) {
    const { repo, prNumber, postComment = true, repoId } = body;

    if (!repo || !prNumber) {
      throw new BadRequestException('repo and prNumber are required');
    }

    this.logger.log(`Manual PR review triggered: ${repo}#${prNumber}`);

    const result = await this.prReviewService.reviewPullRequest(repo, prNumber, {
      postComment,
      repoId,
    });

    return result;
  }

  /**
   * GET /pr-review/list
   * List recent PR reviews (JWT protected).
   */
  @Get('pr-review/list')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List recent PR review records' })
  @ApiQuery({ name: 'limit', required: false, example: '20' })
  @ApiOkResponse({
    description: 'Recent PR reviews',
    schema: {
      example: [
        {
          id: 'f2617e9f-1ab5-4a81-a31e-ac1c4448af65',
          repo: 'demo/codebase',
          prNumber: 24,
          createdAt: '2026-03-16T09:10:11.000Z',
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async listReviews(@Query('limit') limit?: string) {
    return this.prReviewService.listReviews(limit ? parseInt(limit, 10) : 20);
  }

  /**
   * GET /pr-review/:repo/:prNumber
   * Get a specific PR review (JWT protected).
   * Note: repo param uses '__' as '/' separator (e.g. owner__reponame)
   */
  @Get('pr-review/:owner/:repoName/:prNumber')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get one PR review by owner/repo/prNumber' })
  @ApiParam({ name: 'owner', example: 'demo' })
  @ApiParam({ name: 'repoName', example: 'codebase' })
  @ApiParam({ name: 'prNumber', example: '24' })
  @ApiOkResponse({
    description: 'PR review record',
    schema: {
      example: {
        id: 'f2617e9f-1ab5-4a81-a31e-ac1c4448af65',
        repo: 'demo/codebase',
        prNumber: 24,
        findings: [],
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getReview(
    @Param('owner') owner: string,
    @Param('repoName') repoName: string,
    @Param('prNumber') prNumber: string,
  ) {
    const repo = `${owner}/${repoName}`;
    const review = await this.prReviewService.getReview(repo, parseInt(prNumber, 10));
    if (!review) {
      throw new BadRequestException(`No review found for ${repo}#${prNumber}`);
    }
    return review;
  }

  /**
   * GET /webhooks/events
   * List recent webhook events (JWT protected).
   */
  @Get('webhooks/events')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List recent webhook events' })
  @ApiQuery({ name: 'limit', required: false, example: '50' })
  @ApiOkResponse({
    description: 'Webhook event list',
    schema: {
      example: [
        {
          id: '87a5a140-5d59-4b9a-b04d-e5d2c1504f63',
          eventType: 'pull_request',
          processed: true,
          createdAt: '2026-03-16T09:10:11.000Z',
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async listWebhookEvents(@Query('limit') limit?: string) {
    return this.prReviewService.listWebhookEvents(limit ? parseInt(limit, 10) : 50);
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private async runPrReviewAsync(repo: string, prNumber: number, eventId: string): Promise<void> {
    try {
      await this.prReviewService.reviewPullRequest(repo, prNumber, { postComment: true });
      await this.prReviewService.markEventProcessed(eventId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Async PR review failed for ${repo}#${prNumber}: ${msg}`);
      await this.prReviewService.markEventProcessed(eventId, msg);
    }
  }
}
