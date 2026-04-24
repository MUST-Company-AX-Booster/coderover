/**
 * Phase 9 / Workstream F — OpenTelemetry SDK bootstrap.
 *
 * Must be imported BEFORE NestFactory.create() in main.ts so auto-
 * instrumentations patch http, express, pg, ioredis, etc. before they
 * are required.
 *
 * Configuration (env):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  collector URL, default http://localhost:4318
 *   OTEL_SERVICE_NAME            default "coderover-api"
 *   OTEL_ENABLED                 set to "false" to disable (default on)
 *
 * Safe no-op when OTEL_ENABLED=false or init throws.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

let sdk: NodeSDK | null = null;

export function startTracing(): void {
  if (process.env.OTEL_ENABLED === 'false') return;
  if (sdk) return;
  try {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
    const serviceName = process.env.OTEL_SERVICE_NAME || 'coderover-api';
    process.env.OTEL_SERVICE_NAME = serviceName;
    sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Limit noise from fs and DNS; keep http, express, pg, ioredis, bullmq.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
        }),
      ],
    });
    sdk.start();
    // eslint-disable-next-line no-console
    console.log(`[otel] tracing started, exporting to ${endpoint}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[otel] failed to start tracing', err);
    sdk = null;
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try { await sdk.shutdown(); } catch { /* best-effort */ }
  sdk = null;
}
