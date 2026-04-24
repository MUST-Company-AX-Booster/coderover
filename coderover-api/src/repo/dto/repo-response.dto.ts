import { ApiProperty } from '@nestjs/swagger';
import { Repo } from '../../entities/repo.entity';

/**
 * Safe response shape for repo records. **Never** exposes `githubToken`,
 * which was leaking from `RepoController.findAll` before Phase 10
 * (2026-04-16). Replaced with a boolean `hasToken` + a `source` tag so
 * the UI can still indicate "this repo is ready to ingest" without
 * handing the secret back to the client.
 */
export class RepoResponseDto {
  @ApiProperty({ format: 'uuid', example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4' })
  id!: string;

  @ApiProperty({ example: 'demo/codebase' })
  fullName!: string;

  @ApiProperty({ nullable: true, example: 'Demo Codebase' })
  label!: string | null;

  @ApiProperty({ nullable: true, example: 'TypeScript' })
  language!: string | null;

  @ApiProperty({ example: 'main' })
  branch!: string;

  @ApiProperty({ example: 1240 })
  fileCount!: number;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({
    description:
      'True when the repo has a resolvable GitHub token (OAuth connection, stored PAT, or env fallback).',
    example: true,
  })
  hasToken!: boolean;

  @ApiProperty({
    enum: ['oauth', 'manual', 'env'],
    description:
      'How the repo obtains its GitHub token. `oauth` = live from github_connections; `manual` = PAT on repo row; `env` = fallback GITHUB_TOKEN.',
    example: 'oauth',
  })
  source!: 'oauth' | 'manual' | 'env';

  @ApiProperty({ type: String, format: 'date-time', example: '2026-03-16T09:10:11.000Z' })
  createdAt!: Date;

  static fromEntity(repo: Repo, envHasFallbackToken: boolean = false): RepoResponseDto {
    let source: 'oauth' | 'manual' | 'env';
    let hasToken: boolean;
    if (repo.connectedByUserId) {
      source = 'oauth';
      hasToken = true; // resolver fetches live — optimistically true when connected
    } else if (repo.githubToken && repo.githubToken.trim().length > 0) {
      source = 'manual';
      hasToken = true;
    } else {
      source = 'env';
      hasToken = envHasFallbackToken;
    }

    const dto = new RepoResponseDto();
    dto.id = repo.id;
    dto.fullName = repo.fullName;
    dto.label = repo.label ?? null;
    dto.language = repo.language ?? null;
    dto.branch = repo.branch;
    dto.fileCount = repo.fileCount;
    dto.isActive = repo.isActive;
    dto.hasToken = hasToken;
    dto.source = source;
    dto.createdAt = repo.createdAt;
    return dto;
  }
}
