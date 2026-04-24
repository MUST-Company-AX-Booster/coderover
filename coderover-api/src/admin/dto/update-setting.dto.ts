import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateSettingDto {
  @ApiProperty({ description: 'Setting value', example: 'main' })
  @IsNotEmpty()
  value!: string | number | boolean | Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optimistic version number', example: 2 })
  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @ApiPropertyOptional({ description: 'Reason for change', example: 'Enable new provider' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class UpdateLlmConfigDto {
  @ApiPropertyOptional({ example: 'openai' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({ example: 'gpt-4o' })
  @IsOptional()
  @IsString()
  chatModel?: string;

  @ApiPropertyOptional({ example: 'text-embedding-3-large' })
  @IsOptional()
  @IsString()
  embeddingModel?: string;

  @ApiPropertyOptional({ example: 'https://api.openai.com/v1' })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({ example: 1536 })
  @IsOptional()
  @IsNumber()
  embeddingDimensions?: number;

  @ApiPropertyOptional({ example: 'sk-...' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class TestLlmConfigDto {
  @ApiPropertyOptional({ example: 'openai' })
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional({ example: 'gpt-4o-mini' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ example: 0.2 })
  @IsOptional()
  @IsNumber()
  temperature?: number;

  @ApiPropertyOptional({ example: 256 })
  @IsOptional()
  @IsNumber()
  maxTokens?: number;

  @ApiPropertyOptional({ example: 'health check' })
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiPropertyOptional({ description: 'Optional test payload', example: { ping: true } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CleanupLegacySettingsDto {
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
