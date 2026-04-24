import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Phase 9 / Workstream F: Prometheus /metrics endpoint.
 *
 * Exposes process + custom gauges/counters in text format. In production
 * this should sit behind a network-level ACL or basic auth — intentionally
 * omitted here so dev setups can scrape without extra config.
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(await this.metrics.render());
  }
}
