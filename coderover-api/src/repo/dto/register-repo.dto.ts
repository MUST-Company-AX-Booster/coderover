import { IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request body for `POST /repos`. Supports two registration paths:
 *
 * - **OAuth** — user picked a repo from the `/github-integration/repos`
 *   dropdown; frontend sends `connectedByUserId` (the current user's
 *   UUID). At ingest/PR-review time the token is fetched live from
 *   `github_connections`.
 * - **Manual** — user pasted a URL + PAT via the "Advanced" section.
 *   Frontend sends `githubToken`.
 *
 * The two fields are mutually exclusive. When neither is set we fall
 * back to the env `GITHUB_TOKEN` (still supports pre-existing config
 * and public-repo use).
 */
export class RegisterRepoDto {
  @ApiProperty({
    description:
      'GitHub repository URL or "owner/name" slug. Required for both OAuth-selected and manual registration paths.',
    example: 'https://github.com/demo/codebase',
  })
  @IsString()
  repoUrl!: string;

  @ApiPropertyOptional({
    description:
      'Personal Access Token. Use this for the manual "Advanced" registration path. Mutually exclusive with connectedByUserId.',
    example: 'ghp_xxxxxxxxxxxxxxxxxxxx',
  })
  @IsOptional()
  @IsString()
  githubToken?: string;

  @ApiPropertyOptional({
    description:
      'UUID of the user whose github_connections row holds the OAuth token. Set when the repo was selected from the GitHub OAuth dropdown. Mutually exclusive with githubToken.',
  })
  @IsOptional()
  @IsUUID()
  connectedByUserId?: string;

  @ApiPropertyOptional({
    description: 'GitHub numeric repo id (from the OAuth list response). Reserved for future idempotency checks.',
  })
  @IsOptional()
  @IsNumber()
  githubRepoId?: number;

  @ApiPropertyOptional({
    description: 'Default branch for ingestion',
    example: 'main',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({
    description: 'Display label',
    example: 'Demo Codebase',
  })
  @IsOptional()
  @IsString()
  label?: string;
}
