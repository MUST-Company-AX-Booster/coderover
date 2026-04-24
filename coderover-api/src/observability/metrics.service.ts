import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Phase 9 / Workstream F — Prometheus metrics.
 *
 * Thin wrapper around prom-client. Default node metrics (event loop lag,
 * heap, gc, etc.) are collected automatically. Business counters, timers,
 * and gauges are lazily registered on first use so callers don't need to
 * wire them in module constructors.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();
  private counters = new Map<string, Counter<string>>();
  private histograms = new Map<string, Histogram<string>>();
  private gauges = new Map<string, Gauge<string>>();

  onModuleInit(): void {
    this.registry.setDefaultLabels({ service: process.env.OTEL_SERVICE_NAME || 'coderover-api' });
    collectDefaultMetrics({ register: this.registry });
  }

  private labelNames(labels: Record<string, string>): string[] {
    return Object.keys(labels).sort();
  }

  private getCounter(name: string, labels: Record<string, string>): Counter<string> {
    const existing = this.counters.get(name);
    if (existing) return existing;
    const c = new Counter({
      name,
      help: `${name} counter`,
      labelNames: this.labelNames(labels),
      registers: [this.registry],
    });
    this.counters.set(name, c);
    return c;
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const c = this.getCounter(name, labels);
    if (Object.keys(labels).length > 0) c.inc(labels, by);
    else c.inc(by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram({
        name,
        help: `${name} histogram`,
        labelNames: this.labelNames(labels),
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
        registers: [this.registry],
      });
      this.histograms.set(name, h);
    }
    if (Object.keys(labels).length > 0) h.observe(labels, value);
    else h.observe(value);
  }

  set(name: string, value: number, labels: Record<string, string> = {}): void {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge({
        name,
        help: `${name} gauge`,
        labelNames: this.labelNames(labels),
        registers: [this.registry],
      });
      this.gauges.set(name, g);
    }
    if (Object.keys(labels).length > 0) g.set(labels, value);
    else g.set(value);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
