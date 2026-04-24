import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Role } from '../roles.enum';

/**
 * Body of `POST /auth/github/exchange`.
 *
 * The frontend receives a GitHub `code` via the redirect from
 * `/auth/github/callback?code=...` and immediately exchanges it for
 * app tokens via this endpoint. GitHub OAuth codes are single-use and
 * TTL-limited by GitHub (~10 min), so exposing them briefly in the URL
 * is bounded; we never expose app access/refresh tokens in the URL.
 */
export class GithubExchangeDto {
  @ApiProperty({
    description: 'GitHub OAuth authorization code from the callback redirect',
    example: 'b6a4f5e8d9c2a1b3e4f5',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({
    required: false,
    description: 'Opaque state from the callback (used for logging/correlation only — server already validated it)',
  })
  @IsString()
  @IsOptional()
  state?: string;
}

export class GithubLoginUserPayload {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: Role }) role!: Role;
  @ApiProperty({ nullable: true }) name!: string | null;
  @ApiProperty() githubLogin!: string;
  @ApiProperty() githubId!: string;
}

export class GithubLoginOrgPayload {
  @ApiProperty() id!: string;
  @ApiProperty() slug!: string;
}

export class GithubLoginResponseDto {
  @ApiProperty() accessToken!: string;
  /** @deprecated kept for backwards compatibility with older clients */
  @ApiProperty({ deprecated: true }) access_token!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty() token_type!: string;
  @ApiProperty({ type: GithubLoginUserPayload }) user!: GithubLoginUserPayload;
  @ApiProperty({ type: GithubLoginOrgPayload, nullable: true }) org!: GithubLoginOrgPayload | null;
}
