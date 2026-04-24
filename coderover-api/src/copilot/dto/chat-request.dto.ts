import { IsString, IsOptional, IsUUID, IsNotEmpty, MaxLength, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChatRequestDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Existing session ID to continue conversation',
    example: '7de53c38-0f4e-4ea5-b5fd-f844ed53af3f',
  })
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiProperty({
    maxLength: 2000,
    description: 'User prompt message',
    example: 'Summarize the auth flow and list JWT guard usage.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;

  @ApiPropertyOptional({
    description: 'Set true to stream Server-Sent Events',
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Primary repo scope for retrieval',
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
  })
  @IsOptional()
  @IsUUID()
  repoId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Multi-repo scope for retrieval',
    example: [
      'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
      'ffca5f59-a8dc-43f0-ad56-9b22cb8a20ec',
    ],
  })
  @IsOptional()
  @IsUUID('4', { each: true })
  repoIds?: string[];
}
