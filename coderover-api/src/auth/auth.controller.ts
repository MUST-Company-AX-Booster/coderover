import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Role } from './roles.enum';
import { TokenRevocationService } from './token-revocation.service';
import { TokenKind } from '../entities/revoked-token.entity';
import {
  GithubExchangeDto,
  GithubLoginResponseDto,
} from './dto/github-exchange.dto';

export class LoginDto {
  @ApiPropertyOptional({
    example: 'user_123',
    description: 'Optional stable user identifier. If omitted, email is used.',
  })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiProperty({
    example: 'dev@must.co.kr',
    description: 'User email for login',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'SecurePass123!',
    description: 'Password (required since the 2026-04-15 security hotfix).',
  })
  @IsString()
  @IsNotEmpty({ message: 'password is required' })
  password!: string;

  @ApiPropertyOptional({
    required: false,
    enum: Role,
    example: Role.Admin,
  })
  @IsOptional()
  @IsString()
  role?: Role;
}

export class RegisterDto {
  @ApiProperty({ example: 'dev@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'SecurePass123!' })
  @IsString()
  password!: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  @IsString()
  @IsOptional()
  name?: string;
}

export class IssueTokenDto {
  @ApiProperty({
    example: ['search:read', 'graph:read'],
    description:
      'Capability scopes. Narrow tokens carry a subset; full-user tokens leave scope empty.',
  })
  @IsArray()
  @IsString({ each: true })
  scope!: string[];

  @ApiPropertyOptional({
    example: 90,
    description: 'Days until expiry. Defaults to 90, maximum 365.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expires_in_days?: number;

  @ApiPropertyOptional({
    example: 'Claude Code on laptop',
    description: 'Human-readable label shown in the token list.',
  })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({
    example: 'mcp',
    enum: ['user', 'mcp'],
    description: 'Defaults to "mcp". Scoped user tokens are rare; most callers want mcp.',
  })
  @IsOptional()
  @IsIn(['user', 'mcp'])
  kind?: TokenKind;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {}

  /** Login and receive a JWT token */
  @Post('login')
  @ApiOperation({ summary: 'Login and get a JWT access token' })
  @ApiBody({
    type: LoginDto,
    examples: {
      emailLogin: {
        summary: 'Email login',
        value: { email: 'dev@must.co.kr' },
      },
      explicitUser: {
        summary: 'Email with explicit userId',
        value: { userId: 'user_123', email: 'dev@must.co.kr' },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'JWT token issued',
    schema: {
      example: {
        accessToken: '<jwt-token>',
        access_token: '<jwt-token>',
        token_type: 'Bearer',
      },
    },
  })
  async login(@Body() dto: LoginDto) {
    this.logger.log(`Login request for ${dto.email}`);

    // Security (Phase 9): password is REQUIRED. The legacy email-only login
    // path was removed because it accepted caller-supplied identity + role
    // with no credential check, and issued tokens without an orgId claim
    // that then bypassed OrgScopeInterceptor scoping (CVE-fix 2026-04-15).
    if (!dto.password) {
      throw new UnauthorizedException('Password is required');
    }
    return this.authService.loginWithPassword(dto.email, dto.password);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user account' })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ description: 'User created and JWT issued' })
  async register(@Body() dto: RegisterDto) {
    this.logger.log(`Registration request for ${dto.email}`);
    return this.authService.register(dto.email, dto.password, dto.name);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshToken(body.refreshToken);
  }

  @Post('switch-org')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Re-issue token pair scoped to a different organization the user belongs to' })
  async switchOrg(@Req() req: any, @Body() body: { orgId: string }) {
    const userId = req.user?.userId ?? req.user?.sub;
    return this.authService.switchOrg(userId, body.orgId);
  }

  /**
   * Minted authorize URL for GitHub OAuth. State is a cryptographically
   * random, server-validated token (no longer `login-${Date.now()}`).
   */
  @Get('github/connect')
  @ApiOperation({ summary: 'Get GitHub OAuth URL for login' })
  async githubConnect() {
    return this.authService.getGitHubLoginUrl();
  }

  /**
   * GitHub OAuth callback. Validates state and redirects to the frontend
   * with the GitHub authorization code in the URL (NOT the app access
   * token — that lives only in the exchange response body).
   *
   * GitHub auth codes are single-use and GitHub-TTL-bounded (~10 min).
   * Exposing them briefly in a redirect URL is the industry standard
   * pattern for SPA OAuth flows and is materially safer than leaking
   * app-issued access/refresh tokens through the URL bar / server logs.
   */
  @Get('github/callback')
  @ApiOperation({ summary: 'Validate OAuth state and redirect to frontend exchange' })
  async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.get<string>('FRONTEND_APP_URL', 'http://localhost:5173');

    if (error) {
      const params = new URLSearchParams({
        error: errorDescription || error,
        state: state || '',
      });
      return res.redirect(`${frontendUrl}/login?${params.toString()}`);
    }

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Missing code or state in GitHub callback')}`);
    }

    const stateValid = this.authService.consumeOAuthState(state);
    if (!stateValid) {
      this.logger.warn(`OAuth callback with invalid/expired state: ${state.slice(0, 8)}...`);
      return res.redirect(
        `${frontendUrl}/login?error=${encodeURIComponent('Invalid or expired OAuth state — please try again')}`,
      );
    }

    // Note: we do NOT exchange the code here. The frontend posts it to
    // /auth/github/exchange so tokens never transit through a URL.
    const params = new URLSearchParams({ code, state });
    return res.redirect(`${frontendUrl}/auth/github/callback?${params.toString()}`);
  }

  /**
   * Exchange the GitHub authorization code (from the callback redirect)
   * for app tokens. Response body carries the tokens — never the URL.
   */
  @Post('github/exchange')
  @ApiOperation({ summary: 'Exchange a GitHub OAuth code for app access/refresh tokens' })
  @ApiBody({ type: GithubExchangeDto })
  @ApiCreatedResponse({ type: GithubLoginResponseDto })
  async githubExchange(@Body() dto: GithubExchangeDto): Promise<GithubLoginResponseDto> {
    const result = await this.authService.loginWithGitHubCode(dto.code);
    return result;
  }

  /**
   * Phase 10 A4 — Mint a scoped revocable JWT. Only callable by a user
   * (kind === 'user'); MCP tokens cannot issue further tokens (a scoped
   * token that can mint new scoped tokens is a privilege-escalation
   * pattern we explicitly refuse).
   */
  @Post('tokens')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Mint a scoped JWT (e.g. for an MCP client)' })
  @ApiBody({ type: IssueTokenDto })
  async issueToken(@Req() req: any, @Body() dto: IssueTokenDto) {
    const kind = dto.kind ?? 'mcp';
    const callerKind = req.user?.kind ?? 'user';
    if (callerKind !== 'user') {
      throw new ForbiddenException('Only user-kind tokens may mint new tokens');
    }

    const userId: string | undefined = req.user?.userId ?? req.user?.sub;
    const orgId: string | undefined = req.user?.orgId;
    const email: string | undefined = req.user?.email;
    const role: Role | undefined = req.user?.role;

    if (!userId || !orgId || !email || !role) {
      throw new BadRequestException(
        'Cannot issue token: caller JWT is missing userId / orgId / email / role',
      );
    }
    if (!Array.isArray(dto.scope)) {
      throw new BadRequestException('scope must be an array of strings');
    }

    const { token, id, expiresAt } = await this.tokenRevocation.issue({
      userId,
      orgId,
      email,
      role,
      scope: dto.scope,
      kind,
      expiresInDays: dto.expires_in_days,
      label: dto.label ?? null,
    });

    return {
      token,
      id,
      expires_at: expiresAt.toISOString(),
      kind,
      scope: dto.scope,
      label: dto.label ?? null,
    };
  }

  @Delete('tokens/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke a previously-issued token' })
  async revokeToken(@Req() req: any, @Param('id') id: string) {
    const userId: string | undefined = req.user?.userId ?? req.user?.sub;
    if (!userId) throw new UnauthorizedException('Missing user context');
    const row = await this.tokenRevocation.revoke(id, userId);
    return {
      id: row.id,
      revoked_at: row.revokedAt?.toISOString() ?? null,
    };
  }

  @Get('tokens')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List tokens for the caller\'s org' })
  async listTokens(@Req() req: any) {
    const orgId: string | undefined = req.user?.orgId;
    if (!orgId) throw new BadRequestException('JWT missing orgId');
    const rows = await this.tokenRevocation.listForOrg(orgId);
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      scope: r.scope,
      user_id: r.userId,
      expires_at: r.expiresAt.toISOString(),
      revoked_at: r.revokedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    }));
  }
}
