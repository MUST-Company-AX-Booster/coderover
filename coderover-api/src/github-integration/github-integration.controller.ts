import { Body, Controller, Get, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../auth/roles.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { GitHubIntegrationService } from './github-integration.service';
import { SetupWebhookDto } from './dto/setup-webhook.dto';

/**
 * Phase 10 (2026-04-16): this module previously owned its own GitHub
 * OAuth connect/callback pair that wrote to the same `github_connections`
 * table as `/auth/github/*` but with conflicting `userId` semantics.
 * `/connect` and `/callback` now return `410 Gone` pointing at the unified
 * flow. `/repos` and `/webhooks/setup` remain because they require an
 * already-authenticated user and do not initiate OAuth.
 */
@ApiTags('github-integration')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('github-integration')
export class GitHubIntegrationController {
  constructor(private readonly gitHubIntegrationService: GitHubIntegrationService) {}

  @Get('connect')
  @Roles(Role.Admin)
  @ApiOperation({
    summary: '[DEPRECATED] GitHub OAuth connect URL — use /auth/github/connect instead',
    deprecated: true,
  })
  async connectDeprecated() {
    throw new HttpException(
      {
        error: 'Gone',
        message: 'This endpoint has been unified with /auth/github/connect.',
        redirect: '/auth/github/connect',
      },
      HttpStatus.GONE,
    );
  }

  @Get('callback')
  @Roles(Role.Admin)
  @ApiOperation({
    summary: '[DEPRECATED] GitHub OAuth callback — use /auth/github/callback instead',
    deprecated: true,
  })
  async callbackDeprecated() {
    throw new HttpException(
      {
        error: 'Gone',
        message: 'This endpoint has been unified with /auth/github/callback.',
        redirect: '/auth/github/callback',
      },
      HttpStatus.GONE,
    );
  }

  /**
   * List the authenticated user's GitHub repos, sourced from
   * `github_connections.access_token`. Drives the repo picker dropdown.
   *
   * No longer admin-only — any authenticated user who has connected their
   * GitHub account can see their own repos.
   */
  @Get('repos')
  @ApiOperation({ summary: "List the authenticated user's GitHub repositories" })
  @ApiOkResponse({ description: 'GitHub repos the user can access' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token, or no GitHub connection' })
  async repos(@CurrentUser() user: any) {
    return this.gitHubIntegrationService.listRepos(user?.userId ?? user?.sub);
  }

  @Post('webhooks/setup')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Register a webhook on a GitHub repository' })
  @ApiBody({ type: SetupWebhookDto })
  @ApiOkResponse({ description: 'Webhook setup payload' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async setupWebhook(@Body() dto: SetupWebhookDto, @CurrentUser() user: any) {
    return this.gitHubIntegrationService.setupWebhook(dto, user?.userId ?? user?.sub);
  }
}
