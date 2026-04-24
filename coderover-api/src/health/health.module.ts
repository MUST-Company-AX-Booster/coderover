import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { FileWatcherModule } from '../watcher/file-watcher.module';

@Module({
  imports: [BullModule.registerQueue({ name: 'ingest' }), FileWatcherModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
