import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { DataSource } from 'typeorm';
import OpenAI from 'openai';
import { FileWatcherService } from '../watcher/file-watcher.service';
import {
  createLocalChatCompletion,
  getLlmCredentialError,
  normalizeLlmApiKey,
  resolveLlmBaseUrl,
  resolveLlmProvider,
} from '../config/openai.config';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly openai: OpenAI | null;
  private readonly hasLlmConfig: boolean;
  private readonly llmProvider: 'openai' | 'openrouter' | 'local';

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly fileWatcherService: FileWatcherService,
    @InjectQueue('ingest') private readonly ingestQueue: Queue,
  ) {
    const apiKey = normalizeLlmApiKey(this.configService.get<string>('OPENAI_API_KEY'));
    const configuredBaseURL = this.configService.get<string>('OPENAI_BASE_URL');
    const provider = resolveLlmProvider(
      this.configService.get<string>('LLM_PROVIDER'),
      apiKey,
      configuredBaseURL,
    );
    this.llmProvider = provider;
    const baseURL = resolveLlmBaseUrl(provider, configuredBaseURL, apiKey, 'generic');
    this.hasLlmConfig = Boolean(apiKey);
    this.openai = apiKey ? new OpenAI({ apiKey, baseURL }) : null;
  }

  async getHealth() {
    const [db, queue, watcher, embeddings, llm] = await Promise.all([
      this.checkDatabase(),
      this.checkQueue(),
      this.checkWatcher(),
      this.checkEmbeddingCoverage(),
      this.checkLlmConnectivity(),
    ]);

    const status = db.status === 'up' ? 'ok' : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      components: {
        database: db,
        queue,
        watcher,
        llm,
      },
      metrics: {
        embeddingCoverage: embeddings,
      },
    };
  }

  private async checkDatabase() {
    const startedAt = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.logger.warn(`Database health check failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkQueue() {
    try {
      const counts = await this.ingestQueue.getJobCounts();
      return {
        status: 'up',
        name: this.ingestQueue.name,
        depth: counts.waiting + counts.delayed + counts.active,
        counts,
      };
    } catch (error) {
      this.logger.warn(`Queue health check failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: 'down',
        name: this.ingestQueue.name,
        depth: 0,
        counts: {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkWatcher() {
    try {
      const sessions = this.fileWatcherService.getActiveSessions();
      return {
        status: 'up',
        enabled: this.configService.get<string>('FILE_WATCH_ENABLED', 'false') === 'true',
        sessions: sessions.length,
      };
    } catch (error) {
      this.logger.warn(`Watcher health check failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: 'down',
        enabled: this.configService.get<string>('FILE_WATCH_ENABLED', 'false') === 'true',
        sessions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkEmbeddingCoverage() {
    try {
      const [row] = await this.dataSource.query(`
        SELECT
          COUNT(*)::int AS total_chunks,
          COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunks
        FROM code_chunks
      `);

      const totalChunks = Number(row?.total_chunks ?? 0);
      const embeddedChunks = Number(row?.embedded_chunks ?? 0);
      const coveragePercent =
        totalChunks === 0 ? 100 : Number(((embeddedChunks / totalChunks) * 100).toFixed(2));

      return {
        totalChunks,
        embeddedChunks,
        coveragePercent,
      };
    } catch (error) {
      this.logger.warn(
        `Embedding coverage check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        totalChunks: 0,
        embeddedChunks: 0,
        coveragePercent: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkLlmConnectivity() {
    const provider = this.configService.get<string>('LLM_PROVIDER', 'auto');
    const apiKey = normalizeLlmApiKey(this.configService.get<string>('OPENAI_API_KEY'));

    // DX fix 2026-04-15: let operators mark LLM as intentionally offline so a
    // fresh dev box with LLM_PROVIDER=local and nothing on the local endpoint
    // stops reporting `down` with `fetch failed`. Two triggers:
    //   1. Explicit opt-out: LLM_HEALTH_CHECK_ENABLED=false
    //   2. Implicit: local provider with no base URL and no API key configured
    //      (i.e. nothing was ever wired up, so probing would always fail).
    const healthCheckEnabled =
      this.configService.get<string>('LLM_HEALTH_CHECK_ENABLED', 'true') !== 'false';
    const configuredBaseUrl = this.configService.get<string>('OPENAI_BASE_URL');
    const implicitlyDisabled =
      this.llmProvider === 'local' && !configuredBaseUrl && !apiKey;

    if (!healthCheckEnabled || implicitlyDisabled) {
      return {
        status: 'disabled',
        provider,
        reason: !healthCheckEnabled
          ? 'LLM_HEALTH_CHECK_ENABLED=false'
          : 'LLM_PROVIDER=local with no OPENAI_BASE_URL and no OPENAI_API_KEY',
      };
    }

    const credentialError = getLlmCredentialError(this.llmProvider, apiKey);

    if (credentialError) {
      return {
        status: 'down',
        provider,
        error: credentialError,
      };
    }

    const startedAt = Date.now();
    try {
      await Promise.race([
        this.llmProvider === 'local'
          ? createLocalChatCompletion({
              apiKey,
              baseUrl: this.configService.get<string>('OPENAI_BASE_URL'),
              model: this.configService.get<string>('OPENAI_CHAT_MODEL') || 'gpt-4o-mini',
              messages: [{ role: 'user', content: 'Respond with OK' }],
              temperature: 0,
              maxTokens: 8,
            })
          : this.llmProvider === 'openrouter'
            ? this.openai?.chat.completions.create({
                model: this.configService.get<string>('OPENAI_CHAT_MODEL') || 'openai/gpt-4o-mini',
                temperature: 0,
                messages: [{ role: 'user', content: 'Respond with OK' }],
              })
            : this.openai?.models.list(),
        new Promise((_, reject) =>
          // 2026-04-16: bumped 2s → 5s. OpenRouter's models.list() routinely
          // takes 1-2s cold. A 2s budget flipped /health to "down" on every
          // slow poll, even when the LLM was fine.
          setTimeout(() => reject(new Error('LLM connectivity timeout after 5000ms')), 5000),
        ),
      ]);

      return {
        status: 'up',
        provider: this.configService.get<string>('LLM_PROVIDER', 'auto'),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.warn(`LLM health check failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        status: 'down',
        provider: this.configService.get<string>('LLM_PROVIDER', 'auto'),
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
