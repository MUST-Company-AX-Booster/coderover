import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncLog } from '../entities/sync-log.entity';
import { CodeChunk } from '../entities/code-chunk.entity';
import { Repo } from '../entities/repo.entity';
import { CodeMethod } from '../entities/code-method.entity';
import { CodeCall } from '../entities/code-call.entity';
import { CodeInheritance } from '../entities/code-inheritance.entity';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { ChunkerService } from './chunker.service';
import { EmbedderService } from './embedder.service';
import { GitHubService } from './github.service';
import { IngestProcessor } from './processors/ingest.processor';
import { AstService } from './ast.service';
import { MultiLangAstService } from './languages/multi-lang-ast.service';
import { LanguageDetectorService } from './languages/language-detector.service';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { GraphModule } from '../graph/graph.module';
import { RepoModule } from '../repo/repo.module';
import { EventsModule } from '../events/events.module';
import { ObservabilityModule } from '../observability/observability.module';
import { GitHubIntegrationModule } from '../github-integration/github-integration.module';
import { CacheModule } from '../cache/cache.module';
import { IncrementalIngestService } from './incremental-ingest.service';
import { WatchDaemonService } from './watch-daemon.service';
import { TokenCapService } from './token-cap.service';
import { WatchProcessorFactory } from './watch-processor.factory';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SyncLog,
      CodeChunk,
      Repo,
      CodeMethod,
      CodeCall,
      CodeInheritance,
      EdgeProducerAudit,
    ]),
    BullModule.registerQueue({ name: 'ingest' }),
    ArtifactsModule,
    GraphModule,
    forwardRef(() => RepoModule),
    EventsModule,
    ObservabilityModule,
    GitHubIntegrationModule,
    CacheModule,
  ],
  controllers: [IngestController],
  providers: [
    IngestService,
    ChunkerService,
    EmbedderService,
    GitHubService,
    IngestProcessor,
    AstService,
    MultiLangAstService,
    LanguageDetectorService,
    IncrementalIngestService,
    WatchDaemonService,
    TokenCapService,
    WatchProcessorFactory,
  ],
  exports: [
    IngestService,
    ChunkerService,
    EmbedderService,
    GitHubService,
    AstService,
    MultiLangAstService,
    LanguageDetectorService,
    IncrementalIngestService,
    WatchDaemonService,
    TokenCapService,
    WatchProcessorFactory,
  ],
})
export class IngestModule {}
