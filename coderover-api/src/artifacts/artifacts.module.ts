import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContextArtifact } from './context-artifact.entity';
import { ArtifactsService } from './artifacts.service';
import { ArtifactsController } from './artifacts.controller';
import { Repo } from '../entities/repo.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ContextArtifact, Repo])],
  providers: [ArtifactsService],
  controllers: [ArtifactsController],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}
