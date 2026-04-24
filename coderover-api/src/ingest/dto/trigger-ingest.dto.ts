import { IsOptional, IsString, IsBoolean, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TriggerIngestDto {
  @ApiPropertyOptional({
    description: 'GitHub repo full name',
    example: 'demo/codebase',
  })
  @IsOptional()
  @IsString()
  repo?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Registered repository ID',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @IsOptional()
  @IsUUID()
  repoId?: string;

  @ApiPropertyOptional({
    description: 'Target branch',
    example: 'main',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({
    description: 'Force full reindex',
    default: false,
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  forceReindex?: boolean;
}
