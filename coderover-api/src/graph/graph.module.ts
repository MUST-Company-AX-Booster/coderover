import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphService } from './graph.service';
import { GraphController } from './graph.controller';
import { DatabaseModule } from '../database/database.module';
import { MemgraphService } from './memgraph.service';
import { GraphMigrationService } from './graph-migration.service';
import { ConfidenceRetagService } from './confidence-retag.service';
import { ConfidenceTaggerService } from './confidence-tagger.service';
import { GraphMigration } from '../entities/graph-migration.entity';
import { EdgeProducerAudit } from '../entities/edge-producer-audit.entity';

@Module({
  imports: [
    DatabaseModule,
    TypeOrmModule.forFeature([GraphMigration, EdgeProducerAudit]),
  ],
  controllers: [GraphController],
  providers: [
    GraphService,
    MemgraphService,
    GraphMigrationService,
    ConfidenceRetagService,
    ConfidenceTaggerService,
  ],
  exports: [
    GraphService,
    MemgraphService,
    GraphMigrationService,
    ConfidenceRetagService,
    ConfidenceTaggerService,
  ],
})
export class GraphModule {}
