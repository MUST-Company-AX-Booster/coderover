import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class RetrievalDebugRequestDto {
  @ApiProperty({
    example: 'where is auth guard used',
    description: 'Natural-language or keyword query to debug retrieval behavior',
  })
  @IsString()
  query!: string;

  @ApiPropertyOptional({
    example: 8,
    description: 'Maximum number of retrieval rows',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  topK?: number;

  @ApiPropertyOptional({
    example: 'hybrid',
    enum: ['auto', 'semantic', 'keyword', 'hybrid'],
  })
  @IsOptional()
  @IsIn(['auto', 'semantic', 'keyword', 'hybrid'])
  searchMode?: 'auto' | 'semantic' | 'keyword' | 'hybrid';

  @ApiPropertyOptional({
    example: 'd8f2b5d0-40f4-491d-98d7-b0ac3db1e0f4',
    description: 'Optional repository UUID filter',
  })
  @IsOptional()
  @IsUUID()
  repoId?: string;
}
