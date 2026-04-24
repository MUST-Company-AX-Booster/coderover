import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SetupWebhookDto {
  @ApiProperty({ example: 'demo/codebase' })
  @IsString()
  @IsNotEmpty()
  repo!: string;

  @ApiPropertyOptional({ example: 'main' })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pullRequestEvents?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  pushEvents?: boolean;
}
