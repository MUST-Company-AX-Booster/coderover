import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Get service health and runtime metrics' })
  @ApiOkResponse({
    description: 'Health check details',
    schema: {
      example: {
        status: 'ok',
        timestamp: '2026-03-16T09:10:11.000Z',
        components: {
          database: { status: 'up' },
          queue: { status: 'up' },
          watcher: { status: 'up' },
          llm: { status: 'up' },
        },
        metrics: {
          embeddingCoverage: {
            totalChunks: 4921,
            embeddedChunks: 4921,
            ratio: 1,
          },
        },
      },
    },
  })
  async getHealth() {
    return this.healthService.getHealth();
  }
}
