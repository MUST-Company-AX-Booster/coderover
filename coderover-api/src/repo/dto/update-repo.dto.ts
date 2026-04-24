import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateRepoDto {
  @ApiPropertyOptional({
    description: 'Default branch for ingestion',
    example: 'main',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({
    description: 'Display label',
    example: 'Primary Repository',
  })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({
    description: 'Optional GitHub token override for this repo',
    example: 'ghp_xxxxxxxxxxxxxxxxxxxx',
  })
  @IsOptional()
  @IsString()
  githubToken?: string;

  @ApiPropertyOptional({
    description: 'Repository active state',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
