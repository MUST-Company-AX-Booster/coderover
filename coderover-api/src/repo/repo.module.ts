import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { Repo } from '../entities/repo.entity';
import { SyncLog } from '../entities/sync-log.entity';
import { CodeChunk } from '../entities/code-chunk.entity';
import { RepoController } from './repo.controller';
import { RepoService } from './repo.service';
import { IngestModule } from '../ingest/ingest.module';
import { GraphModule } from '../graph/graph.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Repo, SyncLog, CodeChunk]),
    BullModule.registerQueue({ name: 'ingest' }),
    forwardRef(() => IngestModule),
    GraphModule,
  ],
  controllers: [RepoController],
  providers: [RepoService],
  exports: [RepoService],
})
export class RepoModule {}
