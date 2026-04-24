import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { IngestService } from '../ingest.service';
import { TriggerIngestDto } from '../dto/trigger-ingest.dto';

@Processor('ingest')
export class IngestProcessor {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(private readonly ingestService: IngestService) {}

  /** Process a single ingestion job (concurrency: 1) */
  @Process({ name: 'trigger-ingest', concurrency: 1 })
  async handleIngest(job: Job<TriggerIngestDto>) {
    const target = job.data.repo ?? job.data.repoId ?? 'unknown';
    this.logger.log(`Processing ingestion job ${job.id} for ${target}`);

    try {
      const result = await this.ingestService.processIngestion(job.data);
      this.logger.log(`Job ${job.id} completed: ${result.chunksUpserted} chunks upserted`);
      return result;
    } catch (err) {
      this.logger.error(
        `Job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }
}
