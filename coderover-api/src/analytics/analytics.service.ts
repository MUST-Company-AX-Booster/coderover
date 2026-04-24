import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Repo } from '../entities/repo.entity';
import { PrReview } from '../entities/pr-review.entity';
import { WebhookEvent } from '../entities/webhook-event.entity';

export interface AnalyticsSummary {
  repos: {
    total: number;
    active: number;
    list: Array<{ id: string; fullName: string; language: string; fileCount: number; isActive: boolean }>;
  };
  codebase: {
    totalChunks: number;
    totalFiles: number;
    byRepo: Array<{ repoId: string; fullName: string; chunkCount: number }>;
  };
  prReviews: {
    total: number;
    completed: number;
    failed: number;
    avgScore: number | null;
    recent: Array<{ repo: string; prNumber: number; score: number; status: string; createdAt: Date }>;
  };
  webhooks: {
    total: number;
    processed: number;
    pushEvents: number;
    prEvents: number;
    recentErrors: Array<{ repo: string; eventType: string; error: string; createdAt: Date }>;
  };
  generatedAt: string;
}

export interface DashboardActivityItem {
  id: string;
  type: 'ingest' | 'chat' | 'sync';
  message: string;
  timestamp: string;
  status: 'success' | 'warning' | 'error';
}

export interface AnalyticsTimeSeriesPoint {
  date: string;
  chats: number;
  searches: number;
  users: number;
}

export interface DashboardSnapshot {
  stats: {
    totalRepos: number;
    totalChunks: number;
    totalArtifacts: number;
    activeSessions: number;
    lastSyncAt: string | null;
    systemHealth: 'healthy' | 'warning' | 'error';
  };
  dailyUsage: AnalyticsTimeSeriesPoint[];
  repoStats: Array<{
    name: string;
    chunks: number;
    artifacts: number;
    lastSync: string;
  }>;
  languageDistribution: Array<{
    language: string;
    count: number;
    percentage: number;
  }>;
  topQueries: Array<{
    query: string;
    frequency: number;
    category: string;
  }>;
  systemMetrics: {
    totalChats: number;
    totalSearches: number;
    activeUsers: number;
    avgResponseTime: number;
    responseTimeTrendDelta: number;
    responseTimePercentiles: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    tokenUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    totalChunks: number;
    totalArtifacts: number;
  };
  responseTimeSeries: Array<{
    date: string;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    totalTokens: number;
  }>;
  responseTimeByRepo: Array<{
    repo: string;
    requests: number;
    avgMs: number;
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    totalTokens: number;
  }>;
  recentActivity: DashboardActivityItem[];
  generatedAt: string;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(Repo)
    private readonly repoRepository: Repository<Repo>,

    @InjectRepository(PrReview)
    private readonly prReviewRepository: Repository<PrReview>,

    @InjectRepository(WebhookEvent)
    private readonly webhookEventRepository: Repository<WebhookEvent>,

    private readonly dataSource: DataSource,
  ) {}

  async getRepoAnalytics(repoId: string) {
    const chunkStats = await this.dataSource.query(`
      SELECT
        COUNT(*)::int AS total_chunks,
        COUNT(embedding)::int AS embedded_chunks
      FROM code_chunks
      WHERE repo_id = $1
    `, [repoId]);

    const total = chunkStats[0]?.total_chunks || 0;
    const embedded = chunkStats[0]?.embedded_chunks || 0;
    const coverage = total > 0 ? Math.round((embedded / total) * 100) : 0;

    return {
      totalChunks: total,
      embeddedChunks: embedded,
      embeddingCoverage: coverage,
    };
  }

  async getSummary(): Promise<AnalyticsSummary> {
    this.logger.log('Building analytics summary');

    const [repos, prReviews, webhooks, codebase] = await Promise.all([
      this.getRepoStats(),
      this.getPrReviewStats(),
      this.getWebhookStats(),
      this.getCodebaseStats(),
    ]);

    return {
      repos,
      codebase,
      prReviews,
      webhooks,
      generatedAt: new Date().toISOString(),
    };
  }

  async getDashboardSnapshot(range = '7d'): Promise<DashboardSnapshot> {
    const summary = await this.getSummary();
    const days = this.resolveRangeDays(range);
    const [dailyUsage, repoStats, languageDistribution, topQueries, systemMetrics, responseTimeSeries, responseTimeByRepo, recentActivity] =
      await Promise.all([
        this.getDailyUsage(days),
        this.getRepoDashboardStats(),
        this.getLanguageDistribution(),
        this.getTopQueries(),
        this.getSystemMetrics(summary, days),
        this.getResponseTimeSeries(days),
        this.getResponseTimeByRepo(days),
        this.getRecentActivity(),
      ]);

    const webhookErrorCount = summary.webhooks.recentErrors.length;
    const failedReviews = summary.prReviews.failed;
    const systemHealth: 'healthy' | 'warning' | 'error' =
      webhookErrorCount > 0 || failedReviews > 5
        ? webhookErrorCount > 2 || failedReviews > 10
          ? 'error'
          : 'warning'
        : 'healthy';

    const lastSyncAt =
      summary.webhooks.total > 0
        ? summary.webhooks.recentErrors[0]?.createdAt?.toISOString?.() ??
          summary.prReviews.recent[0]?.createdAt?.toISOString?.() ??
          null
        : summary.prReviews.recent[0]?.createdAt?.toISOString?.() ?? null;

    return {
      stats: {
        totalRepos: summary.repos.total,
        totalChunks: summary.codebase.totalChunks,
        totalArtifacts: systemMetrics.totalArtifacts,
        activeSessions: systemMetrics.activeUsers,
        lastSyncAt,
        systemHealth,
      },
      dailyUsage,
      repoStats,
      languageDistribution,
      topQueries,
      systemMetrics,
      responseTimeSeries,
      responseTimeByRepo,
      recentActivity,
      generatedAt: new Date().toISOString(),
    };
  }

  private resolveRangeDays(range: string): number {
    const value = (range || '').trim().toLowerCase();
    if (value === '24h') return 1;
    if (value.endsWith('d')) {
      const days = Number(value.replace('d', ''));
      if (Number.isFinite(days) && days > 0 && days <= 365) return days;
    }
    return 7;
  }

  private async getDailyUsage(days: number): Promise<AnalyticsTimeSeriesPoint[]> {
    try {
      const rows = await this.dataSource.query(
        `
          WITH date_series AS (
            SELECT generate_series(
              (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
              CURRENT_DATE::date,
              INTERVAL '1 day'
            )::date AS day
          ),
          chat_counts AS (
            SELECT DATE(created_at) AS day, COUNT(*)::int AS chats
            FROM chat_messages
            WHERE created_at >= NOW() - ($1::int || ' day')::interval
              AND role = 'assistant'
            GROUP BY DATE(created_at)
          ),
          search_counts AS (
            SELECT DATE(created_at) AS day, COUNT(*)::int AS searches
            FROM chat_messages
            WHERE created_at >= NOW() - ($1::int || ' day')::interval
              AND role = 'user'
            GROUP BY DATE(created_at)
          ),
          user_counts AS (
            SELECT DATE(updated_at) AS day, COUNT(DISTINCT user_id)::int AS users
            FROM chat_sessions
            WHERE updated_at >= NOW() - ($1::int || ' day')::interval
            GROUP BY DATE(updated_at)
          )
          SELECT
            ds.day::text AS date,
            COALESCE(cc.chats, 0) AS chats,
            COALESCE(sc.searches, 0) AS searches,
            COALESCE(uc.users, 0) AS users
          FROM date_series ds
          LEFT JOIN chat_counts cc ON cc.day = ds.day
          LEFT JOIN search_counts sc ON sc.day = ds.day
          LEFT JOIN user_counts uc ON uc.day = ds.day
          ORDER BY ds.day ASC
        `,
        [days],
      );

      return (rows as any[]).map((row) => ({
        date: row.date,
        chats: Number(row.chats) || 0,
        searches: Number(row.searches) || 0,
        users: Number(row.users) || 0,
      }));
    } catch {
      return [];
    }
  }

  private async getRepoDashboardStats(): Promise<
    Array<{
      name: string;
      chunks: number;
      artifacts: number;
      lastSync: string;
    }>
  > {
    try {
      const rows = await this.dataSource.query(`
        SELECT
          r.full_name AS name,
          COALESCE(ch.chunk_count, 0)::int AS chunks,
          COALESCE(ar.artifact_count, 0)::int AS artifacts,
          COALESCE(MAX(we.created_at), r.created_at)::text AS last_sync
        FROM repos r
        LEFT JOIN (
          SELECT repo_id, COUNT(*) AS chunk_count
          FROM code_chunks
          GROUP BY repo_id
        ) ch ON ch.repo_id = r.id
        LEFT JOIN (
          SELECT repo_id, COUNT(*) AS artifact_count
          FROM context_artifacts
          WHERE repo_id IS NOT NULL
          GROUP BY repo_id
        ) ar ON ar.repo_id = r.id
        LEFT JOIN webhook_events we ON we.repo = r.full_name
        GROUP BY r.id, r.full_name, ch.chunk_count, ar.artifact_count, r.created_at
        ORDER BY chunks DESC, artifacts DESC
        LIMIT 12
      `);

      return (rows as any[]).map((row) => ({
        name: row.name,
        chunks: Number(row.chunks) || 0,
        artifacts: Number(row.artifacts) || 0,
        lastSync: row.last_sync ?? new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  private async getLanguageDistribution(): Promise<
    Array<{ language: string; count: number; percentage: number }>
  > {
    const repos = await this.repoRepository.find({ order: { createdAt: 'DESC' } });
    const languageCounts = new Map<string, number>();
    let total = 0;

    for (const repo of repos) {
      const language = repo.language || 'Unknown';
      const count = Math.max(1, Number(repo.fileCount) || 1);
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + count);
      total += count;
    }

    if (total === 0) return [];

    return [...languageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([language, count]) => ({
        language,
        count,
        percentage: Math.round((count / total) * 100),
      }));
  }

  private async getTopQueries(): Promise<
    Array<{
      query: string;
      frequency: number;
      category: string;
    }>
  > {
    try {
      const rows = await this.dataSource.query(`
        SELECT
          LEFT(content, 140) AS query,
          COUNT(*)::int AS frequency
        FROM chat_messages
        WHERE role = 'user'
          AND length(trim(content)) >= 3
        GROUP BY LEFT(content, 140)
        ORDER BY frequency DESC
        LIMIT 8
      `);

      return (rows as any[]).map((row) => ({
        query: row.query,
        frequency: Number(row.frequency) || 0,
        category: this.classifyQuery(row.query),
      }));
    } catch {
      return [];
    }
  }

  private classifyQuery(query: string): string {
    const value = query.toLowerCase();
    if (/(auth|token|jwt|permission|role)/.test(value)) return 'Security';
    if (/(sql|db|database|schema|migration)/.test(value)) return 'Database';
    if (/(api|endpoint|controller|route)/.test(value)) return 'API';
    if (/(test|jest|spec|coverage)/.test(value)) return 'Testing';
    if (/(performance|latency|slow|optimi)/.test(value)) return 'Performance';
    return 'General';
  }

  private async getSystemMetrics(
    summary: AnalyticsSummary,
    days: number,
  ): Promise<{
    totalChats: number;
    totalSearches: number;
    activeUsers: number;
    avgResponseTime: number;
    responseTimeTrendDelta: number;
    responseTimePercentiles: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    tokenUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    totalChunks: number;
    totalArtifacts: number;
  }> {
    try {
      const [chatRows, artifactRows, activeUserRows, latencyRows, previousLatencyRows] = await Promise.all([
        this.dataSource.query(`
          SELECT
            COUNT(*) FILTER (WHERE role = 'assistant')::int AS total_chats,
            COUNT(*) FILTER (WHERE role = 'user')::int AS total_searches
          FROM chat_messages
        `),
        this.dataSource.query(`
          SELECT COUNT(*)::int AS total_artifacts
          FROM context_artifacts
        `),
        this.dataSource.query(`
          SELECT COUNT(DISTINCT user_id)::int AS active_users
          FROM chat_sessions
          WHERE updated_at >= NOW() - INTERVAL '15 minutes'
        `),
        this.dataSource.query(
          `
            SELECT
              COALESCE(AVG(duration_ms), 0)::float AS avg_response_time,
              COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p50,
              COALESCE(percentile_cont(0.90) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p90,
              COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p95,
              COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p99,
              COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
              COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
            FROM ai_request_metrics
            WHERE status = 'completed'
              AND duration_ms IS NOT NULL
              AND created_at >= NOW() - ($1::int || ' day')::interval
          `,
          [days],
        ),
        this.dataSource.query(
          `
            SELECT
              COALESCE(AVG(duration_ms), 0)::float AS avg_response_time
            FROM ai_request_metrics
            WHERE status = 'completed'
              AND duration_ms IS NOT NULL
              AND created_at >= NOW() - (($1::int * 2) || ' day')::interval
              AND created_at < NOW() - ($1::int || ' day')::interval
          `,
          [days],
        ),
      ]);

      const currentAvg = Number(latencyRows[0]?.avg_response_time) || 0;
      const previousAvg = Number(previousLatencyRows[0]?.avg_response_time) || 0;
      const trendDelta =
        previousAvg > 0 ? Number((((currentAvg - previousAvg) / previousAvg) * 100).toFixed(2)) : 0;

      return {
        totalChats: Number(chatRows[0]?.total_chats) || 0,
        totalSearches: Number(chatRows[0]?.total_searches) || 0,
        activeUsers: Number(activeUserRows[0]?.active_users) || 0,
        avgResponseTime: currentAvg,
        responseTimeTrendDelta: trendDelta,
        responseTimePercentiles: {
          p50: Number(latencyRows[0]?.p50) || 0,
          p90: Number(latencyRows[0]?.p90) || 0,
          p95: Number(latencyRows[0]?.p95) || 0,
          p99: Number(latencyRows[0]?.p99) || 0,
        },
        tokenUsage: {
          promptTokens: Number(latencyRows[0]?.prompt_tokens) || 0,
          completionTokens: Number(latencyRows[0]?.completion_tokens) || 0,
          totalTokens: Number(latencyRows[0]?.total_tokens) || 0,
        },
        totalChunks: summary.codebase.totalChunks,
        totalArtifacts: Number(artifactRows[0]?.total_artifacts) || 0,
      };
    } catch {
      return {
        totalChats: 0,
        totalSearches: 0,
        activeUsers: 0,
        avgResponseTime: 0,
        responseTimeTrendDelta: 0,
        responseTimePercentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalChunks: summary.codebase.totalChunks,
        totalArtifacts: 0,
      };
    }
  }

  private async getResponseTimeSeries(days: number): Promise<
    Array<{
      date: string;
      avgMs: number;
      p50Ms: number;
      p90Ms: number;
      p99Ms: number;
      totalTokens: number;
    }>
  > {
    try {
      const rows = await this.dataSource.query(
        `
          WITH date_series AS (
            SELECT generate_series(
              (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
              CURRENT_DATE::date,
              INTERVAL '1 day'
            )::date AS day
          ),
          metrics AS (
            SELECT
              DATE(created_at) AS day,
              COALESCE(AVG(duration_ms), 0)::float AS avg_ms,
              COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p50_ms,
              COALESCE(percentile_cont(0.90) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p90_ms,
              COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::float AS p99_ms,
              COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
            FROM ai_request_metrics
            WHERE status = 'completed'
              AND duration_ms IS NOT NULL
              AND created_at >= NOW() - ($1::int || ' day')::interval
            GROUP BY DATE(created_at)
          )
          SELECT
            ds.day::text AS date,
            COALESCE(m.avg_ms, 0)::float AS avg_ms,
            COALESCE(m.p50_ms, 0)::float AS p50_ms,
            COALESCE(m.p90_ms, 0)::float AS p90_ms,
            COALESCE(m.p99_ms, 0)::float AS p99_ms,
            COALESCE(m.total_tokens, 0)::bigint AS total_tokens
          FROM date_series ds
          LEFT JOIN metrics m ON m.day = ds.day
          ORDER BY ds.day ASC
        `,
        [days],
      );

      return (rows as any[]).map((row) => ({
        date: row.date,
        avgMs: Number(row.avg_ms) || 0,
        p50Ms: Number(row.p50_ms) || 0,
        p90Ms: Number(row.p90_ms) || 0,
        p99Ms: Number(row.p99_ms) || 0,
        totalTokens: Number(row.total_tokens) || 0,
      }));
    } catch {
      return [];
    }
  }

  private async getResponseTimeByRepo(days: number): Promise<
    Array<{
      repo: string;
      requests: number;
      avgMs: number;
      p50Ms: number;
      p90Ms: number;
      p99Ms: number;
      totalTokens: number;
    }>
  > {
    try {
      const rows = await this.dataSource.query(
        `
          SELECT
            COALESCE(r.full_name, m.repo_full_name, 'global') AS repo,
            COUNT(*)::int AS requests,
            COALESCE(AVG(m.duration_ms), 0)::float AS avg_ms,
            COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY m.duration_ms), 0)::float AS p50_ms,
            COALESCE(percentile_cont(0.90) WITHIN GROUP (ORDER BY m.duration_ms), 0)::float AS p90_ms,
            COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY m.duration_ms), 0)::float AS p99_ms,
            COALESCE(SUM(m.total_tokens), 0)::bigint AS total_tokens
          FROM ai_request_metrics m
          LEFT JOIN repos r ON r.id = m.repo_id
          WHERE m.status = 'completed'
            AND m.duration_ms IS NOT NULL
            AND m.created_at >= NOW() - ($1::int || ' day')::interval
          GROUP BY COALESCE(r.full_name, m.repo_full_name, 'global')
          ORDER BY p90_ms DESC, requests DESC
          LIMIT 12
        `,
        [days],
      );

      return (rows as any[]).map((row) => ({
        repo: row.repo,
        requests: Number(row.requests) || 0,
        avgMs: Number(row.avg_ms) || 0,
        p50Ms: Number(row.p50_ms) || 0,
        p90Ms: Number(row.p90_ms) || 0,
        p99Ms: Number(row.p99_ms) || 0,
        totalTokens: Number(row.total_tokens) || 0,
      }));
    } catch {
      return [];
    }
  }

  private async getRecentActivity(): Promise<DashboardActivityItem[]> {
    const [webhooks, reviews, sessions] = await Promise.all([
      this.webhookEventRepository.find({
        order: { createdAt: 'DESC' },
        take: 10,
      }),
      this.prReviewRepository.find({
        order: { createdAt: 'DESC' },
        take: 10,
      }),
      this.dataSource.query(`
        SELECT id::text, title, updated_at
        FROM chat_sessions
        ORDER BY updated_at DESC
        LIMIT 10
      `),
    ]);

    const webhookItems: DashboardActivityItem[] = webhooks.map((event) => ({
      id: `webhook-${event.id}`,
      type: 'ingest',
      message: `${event.eventType} ${event.action ?? ''} ${event.repo}`.trim(),
      timestamp: event.createdAt.toISOString(),
      status: event.error ? 'error' : event.processed ? 'success' : 'warning',
    }));

    const reviewItems: DashboardActivityItem[] = reviews.map((review) => ({
      id: `review-${review.id}`,
      type: 'sync',
      message: `PR #${review.prNumber} review ${review.status} (${review.repo})`,
      timestamp: review.createdAt.toISOString(),
      status: review.status === 'failed' ? 'error' : review.status === 'in_progress' ? 'warning' : 'success',
    }));

    const sessionItems: DashboardActivityItem[] = (sessions as any[]).map((session) => ({
      id: `chat-${session.id}`,
      type: 'chat',
      message: `Chat activity: ${session.title || 'Untitled session'}`,
      timestamp: new Date(session.updated_at).toISOString(),
      status: 'success',
    }));

    return [...webhookItems, ...reviewItems, ...sessionItems]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 15);
  }

  private async getRepoStats() {
    const repos = await this.repoRepository.find({ order: { createdAt: 'DESC' } });
    return {
      total: repos.length,
      active: repos.filter((r) => r.isActive).length,
      list: repos.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        language: r.language ?? 'Unknown',
        fileCount: r.fileCount,
        isActive: r.isActive,
      })),
    };
  }

  private async getCodebaseStats() {
    try {
      // Total chunks and files
      const totals = await this.dataSource.query(`
        SELECT
          COUNT(*)::int           AS total_chunks,
          COUNT(DISTINCT file_path)::int AS total_files
        FROM code_chunks
      `);

      // Per-repo breakdown
      const byRepo = await this.dataSource.query(`
        SELECT
          cc.repo_id,
          r.full_name,
          COUNT(*)::int AS chunk_count
        FROM code_chunks cc
        LEFT JOIN repos r ON r.id = cc.repo_id
        GROUP BY cc.repo_id, r.full_name
        ORDER BY chunk_count DESC
        LIMIT 20
      `);

      return {
        totalChunks: totals[0]?.total_chunks ?? 0,
        totalFiles: totals[0]?.total_files ?? 0,
        byRepo: (byRepo as any[]).map((row) => ({
          repoId: row.repo_id ?? 'global',
          fullName: row.full_name ?? 'global',
          chunkCount: row.chunk_count,
        })),
      };
    } catch {
      return { totalChunks: 0, totalFiles: 0, byRepo: [] };
    }
  }

  private async getPrReviewStats() {
    const reviews = await this.prReviewRepository.find({
      order: { createdAt: 'DESC' },
      take: 100,
    });

    const completed = reviews.filter((r) => r.status === 'completed');
    const failed = reviews.filter((r) => r.status === 'failed');

    // Avg score from JSONB findings (score stored in findings.score or as top-level)
    const scores = completed
      .map((r) => {
        if (r.findings && typeof r.findings === 'object' && 'score' in r.findings) {
          return Number((r.findings as any).score);
        }
        return null;
      })
      .filter((s): s is number => s !== null && !isNaN(s));

    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    return {
      total: reviews.length,
      completed: completed.length,
      failed: failed.length,
      avgScore,
      recent: reviews.slice(0, 10).map((r) => ({
        repo: r.repo,
        prNumber: r.prNumber,
        score: (r.findings as any)?.score ?? 0,
        status: r.status,
        createdAt: r.createdAt,
      })),
    };
  }

  private async getWebhookStats() {
    const events = await this.webhookEventRepository.find({
      order: { createdAt: 'DESC' },
      take: 200,
    });

    const errors = events.filter((e) => e.error);

    return {
      total: events.length,
      processed: events.filter((e) => e.processed).length,
      pushEvents: events.filter((e) => e.eventType === 'push').length,
      prEvents: events.filter((e) => e.eventType === 'pull_request').length,
      recentErrors: errors.slice(0, 5).map((e) => ({
        repo: e.repo,
        eventType: e.eventType,
        error: e.error ?? '',
        createdAt: e.createdAt,
      })),
    };
  }
}
