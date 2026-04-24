import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Repo } from '../entities/repo.entity';
import { FileWatcherService } from './file-watcher.service';
import { FileWatcherController } from './file-watcher.controller';
import { IngestModule } from '../ingest/ingest.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Repo]),
    IngestModule,
    ArtifactsModule,
  ],
  providers: [FileWatcherService],
  controllers: [FileWatcherController],
  exports: [FileWatcherService],
})
export class FileWatcherModule {}
