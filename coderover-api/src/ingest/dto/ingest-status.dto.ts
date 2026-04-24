import { ApiProperty } from '@nestjs/swagger';

export class IngestStatusDto {
  @ApiProperty({ example: 'indexed' })
  status!: string;

  @ApiProperty({ example: 'demo/codebase' })
  repo!: string;

  @ApiProperty({ example: 'deaa73e9afef0325ad95ff6ec57d89f5f89f3341' })
  commitSha!: string;

  @ApiProperty({ example: 152 })
  filesIndexed!: number;

  @ApiProperty({ example: 2280 })
  chunksTotal!: number;

  @ApiProperty({ example: 320 })
  chunksUpserted!: number;

  @ApiProperty({ example: 12 })
  chunksDeleted!: number;

  @ApiProperty({ type: [String], example: [] })
  errors!: string[];

  @ApiProperty({ example: 13654 })
  durationMs!: number;
}
