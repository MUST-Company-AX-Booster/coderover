import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { apiClient } from '../stores/authStore';
import { toast } from 'sonner';
import CodeDiff from '../components/CodeDiff';
import ConfidenceMark from '../components/ConfidenceMark';
import type { CitationConfidenceTag } from '../lib/api/copilot';
import {
  GitPullRequest,
  CheckCircle,
  XCircle,
  AlertTriangle,
  MessageSquare,
  Info,
  Shield,
  Zap,
  Bug,
  Paintbrush,
  Wrench,
  ExternalLink,
  Clock,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Eyebrow } from '@/components/brand';

interface ReviewFinding {
  severity: 'critical' | 'warning' | 'suggestion' | 'info';
  file: string;
  line?: number;
  message: string;
  category: 'security' | 'performance' | 'correctness' | 'style' | 'maintainability';
  /** Phase 10 B1/B2: how the finding was produced. */
  confidence?: CitationConfidenceTag;
  confidenceScore?: number | null;
  /** Free-text producer trail (e.g. "grep + AST"), shown in the source-attribution row. */
  producer?: string;
}

const PRODUCER_DEFAULTS: Record<CitationConfidenceTag, string> = {
  EXTRACTED: 'grep + AST',
  INFERRED: 'llm',
  AMBIGUOUS: 'unresolved',
};

/**
 * Phase 10 B3: dedicated leading row for each finding. Italic muted text per
 * plan. The mark is rendered next to the attribution — for EXTRACTED the
 * trail reads `[extracted · grep + AST]` (no why?). For INFERRED/AMBIGUOUS
 * the attribution contains a clickable "why?" that opens a B4 evidence
 * accordion. Loading state shows a skeleton; B4 lands the real payload.
 */
function FindingAttribution({ finding }: { finding: ReviewFinding }) {
  const tag: CitationConfidenceTag = finding.confidence ?? 'AMBIGUOUS';
  const score = finding.confidenceScore ?? null;
  const producer = finding.producer ?? PRODUCER_DEFAULTS[tag];
  const [whyOpen, setWhyOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const reactId = useId();
  const panelId = `why-panel-${reactId}`;

  const canExpand = tag !== 'EXTRACTED';

  const handleToggle = () => {
    setWhyOpen((v) => !v);
  };

  // Return focus to trigger only on *collapse* (not initial mount).
  useEffect(() => {
    if (wasOpenRef.current && !whyOpen) {
      buttonRef.current?.focus({ preventScroll: true });
    }
    wasOpenRef.current = whyOpen;
  }, [whyOpen]);

  const fmt = score != null ? score.toFixed(1) : null;
  const leftLabel =
    tag === 'EXTRACTED'
      ? `[extracted \u00B7 ${producer}]`
      : tag === 'INFERRED'
        ? fmt
          ? `[inferred ${fmt} \u00B7 `
          : `[inferred \u00B7 `
        : `[ambiguous \u00B7 `;

  return (
    <div
      className="flex flex-col gap-1 px-4 pt-2 pb-1 bg-card/50"
      data-testid="finding-attribution"
    >
      <div className="flex items-center gap-2">
        <ConfidenceMark tag={tag} score={score} surface="pr" />
        <span className="italic text-[11px] text-muted-foreground">
          {leftLabel}
          {canExpand && (
            <>
              <button
                ref={buttonRef}
                type="button"
                onClick={handleToggle}
                aria-expanded={whyOpen}
                aria-controls={panelId}
                className="underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm"
                data-testid="finding-why-trigger"
              >
                why?
              </button>
              <span>]</span>
            </>
          )}
        </span>
      </div>
      {canExpand && whyOpen && (
        <div
          id={panelId}
          role="region"
          aria-label="confidence evidence"
          className="ml-6 mt-1 max-w-md rounded-md border border-border bg-card px-3 py-2 text-[12px] text-foreground transition-[max-height,opacity] duration-200 ease-out"
          data-testid="finding-why-panel"
        >
          <EvidenceLoadingSkeleton />
        </div>
      )}
    </div>
  );
}

function EvidenceLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <span className="text-[11px] text-muted-foreground">loading...</span>
      <div className="h-2 w-3/4 rounded bg-foreground/10" />
      <div className="h-2 w-1/2 rounded bg-foreground/10" />
    </div>
  );
}

interface ReviewDetail {
  prNumber: number;
  repo: string;
  summary?: string;
  findings: ReviewFinding[];
  score: number;
  recommendation: 'approve' | 'request_changes' | 'comment';
  postedCommentUrl?: string | null;
  prReviewId?: string;
  tokensUsed?: number | null;
  // entity fields
  id?: string;
  status?: string;
  diffSummary?: string;
  aiModel?: string;
  llmLatencyMs?: number;
  llmDurationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  createdAt?: string;
  reviewUrl?: string;
}

interface PrReviewItem {
  id: string;
  repo: string;
  prNumber: number;
  status: string;
  createdAt: string;
  findings?: unknown[];
  score?: number;
  recommendation?: string;
}

interface WebhookEventItem {
  id: string;
  eventType: string;
  processed: boolean;
  createdAt: string;
}

// Brand severity config — mono level tokens in accent/destructive/warning/silver.
// Row surface stays the card neutral; only the level token carries signal color.
const severityConfig = {
  critical:   { icon: XCircle,        label: 'BLOCK',  color: 'text-destructive' },
  warning:    { icon: AlertTriangle,  label: 'WARN',   color: 'text-warning-500' },
  suggestion: { icon: MessageSquare,  label: 'NOTE',   color: 'text-accent' },
  info:       { icon: Info,           label: 'INFO',   color: 'text-muted-foreground' },
} as const;

const categoryConfig: Record<string, { icon: typeof Shield; label: string }> = {
  security: { icon: Shield, label: 'Security' },
  performance: { icon: Zap, label: 'Performance' },
  correctness: { icon: Bug, label: 'Correctness' },
  style: { icon: Paintbrush, label: 'Style' },
  maintainability: { icon: Wrench, label: 'Maintainability' },
};

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 85 ? 'text-success-700 bg-success-100 border-success-300' :
    score >= 55 ? 'text-warning-700 bg-warning-100 border-warning-300' :
    'text-error-700 bg-error-100 border-error-300';

  return (
    <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border font-semibold text-lg ${color}`}>
      {score}<span className="text-xs font-normal opacity-70">/ 100</span>
    </div>
  );
}

function RecommendationBanner({ recommendation }: { recommendation: string }) {
  const config = {
    approve: { icon: CheckCircle, text: 'Approved', desc: 'No critical issues found', bg: 'bg-success-50 border-success-200', color: 'text-success-700' },
    request_changes: { icon: XCircle, text: 'Changes Requested', desc: 'Critical issues need attention', bg: 'bg-error-50 border-error-200', color: 'text-error-700' },
    comment: { icon: MessageSquare, text: 'Comments', desc: 'Non-blocking suggestions provided', bg: 'bg-info-50 border-info-200', color: 'text-info-700' },
  }[recommendation] ?? { icon: Info, text: recommendation, desc: '', bg: 'bg-foreground/5 border-border', color: 'text-foreground' };

  const Icon = config.icon;
  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${config.bg}`}>
      <Icon className={`h-5 w-5 ${config.color}`} />
      <div>
        <span className={`font-semibold ${config.color}`}>{config.text}</span>
        {config.desc && <span className="text-muted-foreground text-sm ml-2">{config.desc}</span>}
      </div>
    </div>
  );
}

function FindingsTable({ findings }: { findings: ReviewFinding[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: findings.length };
    findings.forEach((f) => { c[f.severity] = (c[f.severity] || 0) + 1; });
    return c;
  }, [findings]);

  const filtered = filter === 'all' ? findings : findings.filter((f) => f.severity === filter);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap font-mono text-[11px] uppercase tracking-[0.18em]">
        {['all', 'critical', 'warning', 'suggestion', 'info'].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 border transition-colors ${
              filter === s
                ? 'border-foreground text-foreground bg-foreground/[0.05]'
                : 'border-foreground/20 text-muted-foreground hover:text-foreground hover:border-foreground/40'
            }`}
          >
            {s === 'all' ? 'all' : s}
            {counts[s] ? ` · ${counts[s]}` : ''}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="py-6 font-mono text-sm">
          <span className="text-muted-foreground">[scout] </span>
          <span className="text-foreground/80">no findings match this filter.</span>
        </div>
      ) : (
        <div className="border border-border bg-card divide-y divide-border">
          {filtered.map((finding, idx) => {
            const sev = severityConfig[finding.severity] || severityConfig.info;
            const cat = categoryConfig[finding.category];
            const CatIcon = cat?.icon;
            const isExpanded = expandedIdx === idx;
            const fileCite = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;

            return (
              <div key={idx}>
                <FindingAttribution finding={finding} />
                <button
                  onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                  className="w-full text-left px-4 py-3 hover:bg-foreground/[0.03] transition-colors"
                >
                  <div className="flex items-start gap-3 font-mono text-sm">
                    <span className="select-none text-muted-foreground shrink-0" aria-hidden>[scout]</span>
                    <span className={`shrink-0 font-medium ${sev.color}`}>{sev.label}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-foreground truncate" title={fileCite}>{fileCite}</span>
                        {cat && CatIcon && (
                          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
                            <CatIcon className="h-3 w-3" aria-hidden />
                            {cat.label.toLowerCase()}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-sans text-sm text-foreground/90 line-clamp-2">{finding.message}</p>
                    </div>
                    <span className="shrink-0 pt-0.5 text-muted-foreground">
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-4 py-3 border-t border-border space-y-3 bg-background/40">
                    <div className="space-y-1 font-mono text-xs">
                      <div>
                        <span className="text-muted-foreground">file </span>
                        <span className="text-foreground">{fileCite}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">note </span>
                        <span className="font-sans text-foreground/90">{finding.message}</span>
                      </div>
                    </div>
                    <CodeDiff file={finding.file} line={finding.line} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewDetailPanel({ review }: { review: ReviewDetail }) {
  const findings = useMemo(() => {
    if (Array.isArray(review.findings)) return review.findings as ReviewFinding[];
    const f = review.findings as unknown;
    if (f && typeof f === 'object' && 'items' in (f as Record<string, unknown>)) {
      return ((f as Record<string, unknown>).items as ReviewFinding[]) || [];
    }
    return [];
  }, [review.findings]);

  const score = typeof review.score === 'number' ? review.score : (review.findings as unknown as { score?: number })?.score ?? 0;
  const recommendation = review.recommendation || (review.findings as unknown as { recommendation?: string })?.recommendation || 'comment';
  const summary = review.summary || review.diffSummary || '';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <GitPullRequest className="h-6 w-6 text-primary-600" />
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {review.repo} <span className="text-primary-600">#{review.prNumber}</span>
            </h3>
            {review.createdAt && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3" />
                {new Date(review.createdAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ScoreBadge score={score} />
          {(review.postedCommentUrl || review.reviewUrl) && (
            <a
              href={review.postedCommentUrl || review.reviewUrl || '#'}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-outline text-xs flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              View on GitHub
            </a>
          )}
        </div>
      </div>

      {/* Recommendation */}
      <RecommendationBanner recommendation={recommendation} />

      {/* Summary */}
      {summary && (
        <div className="card p-4">
          <h4 className="text-sm font-semibold text-foreground mb-2">Summary</h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{summary}</p>
        </div>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-3 text-center">
          <div className="text-lg font-bold text-foreground">{findings.length}</div>
          <div className="text-xs text-muted-foreground">Findings</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-lg font-bold text-error-600">{findings.filter((f) => f.severity === 'critical').length}</div>
          <div className="text-xs text-muted-foreground">Critical</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-lg font-bold text-warning-600">{findings.filter((f) => f.severity === 'warning').length}</div>
          <div className="text-xs text-muted-foreground">Warnings</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-lg font-bold text-muted-foreground">
            {review.totalTokens || review.tokensUsed || '-'}
          </div>
          <div className="text-xs text-muted-foreground">Tokens</div>
        </div>
      </div>

      {/* AI Model & Latency */}
      {(review.aiModel || review.llmLatencyMs) && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {review.aiModel && <span>Model: <code className="bg-foreground/10 px-1.5 py-0.5 rounded">{review.aiModel}</code></span>}
          {review.llmLatencyMs && <span>Latency: {review.llmLatencyMs}ms</span>}
          {review.llmDurationMs && <span>Duration: {(review.llmDurationMs / 1000).toFixed(1)}s</span>}
        </div>
      )}

      {/* Findings */}
      {findings.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold text-foreground mb-3">Findings</h4>
          <FindingsTable findings={findings} />
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <CheckCircle className="h-8 w-8 mx-auto mb-2 text-success-500" />
          <p className="text-sm">No issues found in this review.</p>
        </div>
      )}
    </div>
  );
}

export default function PrReviewsPage() {
  const [repo, setRepo] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [postComment, setPostComment] = useState(true);
  const [reviews, setReviews] = useState<PrReviewItem[]>([]);
  const [events, setEvents] = useState<WebhookEventItem[]>([]);
  const [selectedReview, setSelectedReview] = useState<ReviewDetail | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showEvents, setShowEvents] = useState(false);

  const hasValidTrigger = useMemo(() => repo.includes('/') && Number(prNumber) > 0, [repo, prNumber]);

  const refresh = async () => {
    try {
      const [reviewList, eventList] = await Promise.all([
        apiClient.get<PrReviewItem[]>('/pr-review/list?limit=25'),
        apiClient.get<WebhookEventItem[]>('/webhooks/events?limit=25'),
      ]);
      setReviews(reviewList);
      setEvents(eventList);
    } catch (error) {
      console.error(error);
      toast.error('Failed to load PR review data');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const triggerReview = async () => {
    if (!hasValidTrigger) return;
    try {
      setIsSubmitting(true);
      const result = await apiClient.post<ReviewDetail>('/pr-review/trigger', {
        repo,
        prNumber: Number(prNumber),
        postComment,
      });
      setSelectedReview(result);
      toast.success('PR review completed');
      await refresh();
    } catch (error) {
      console.error(error);
      toast.error('Failed to trigger PR review');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openReview = async (item: PrReviewItem) => {
    try {
      const [owner, repoName] = item.repo.split('/');
      if (!owner || !repoName) return;
      const detail = await apiClient.get<ReviewDetail>(
        `/pr-review/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/${item.prNumber}`,
      );
      setSelectedReview(detail);
    } catch (error) {
      console.error(error);
      toast.error('Failed to fetch review detail');
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      completed: 'bg-success-100 text-success-700',
      failed: 'bg-error-100 text-error-700',
      pending: 'bg-warning-100 text-warning-700',
      in_progress: 'bg-info-100 text-info-700',
    };
    return styles[status] || 'bg-foreground/10 text-muted-foreground';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3">
        <Eyebrow prefix>Scout Reports</Eyebrow>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-normal tracking-tight">
              [scout] reviewing every PR.{' '}
              <span className="text-muted-foreground">You read the comments, not the diff.</span>
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Trigger, inspect, and monitor autonomous pull-request review.
            </p>
          </div>
          <button onClick={refresh} className="btn btn-outline flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Trigger Form */}
      <div className="card p-6 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Trigger Review</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground mb-1">Repository</label>
            <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">PR Number</label>
            <input
              className="input"
              type="number"
              min={1}
              value={prNumber}
              onChange={(e) => setPrNumber(e.target.value)}
              placeholder="PR #"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={postComment} onChange={(e) => setPostComment(e.target.checked)} className="rounded" />
              Post to GitHub
            </label>
          </div>
        </div>
        <button className="btn btn-primary flex items-center gap-2" onClick={triggerReview} disabled={!hasValidTrigger || isSubmitting}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
          {isSubmitting ? 'Reviewing...' : 'Start PR Review'}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Reviews List */}
        <div className="card p-6 xl:col-span-1">
          <h2 className="text-lg font-semibold text-foreground mb-4">Recent Reviews</h2>
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {reviews.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center">No reviews yet. Trigger one above.</div>
            ) : (
              reviews.map((item) => (
                <button
                  key={item.id}
                  onClick={() => openReview(item)}
                  className={`w-full text-left border rounded-lg px-3 py-2.5 transition-colors ${
                    selectedReview?.prReviewId === item.id || selectedReview?.id === item.id
                      ? 'border-primary-400 bg-primary-50'
                      : 'border-border hover:bg-foreground/5'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground text-sm">
                      {item.repo} <span className="text-primary-600">#{item.prNumber}</span>
                    </span>
                    <span className={`text-[10px] uppercase tracking-wide font-medium px-2 py-0.5 rounded-full ${getStatusBadge(item.status)}`}>
                      {item.status}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{new Date(item.createdAt).toLocaleString()}</div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Review Detail */}
        <div className="card p-6 xl:col-span-2">
          <h2 className="text-lg font-semibold text-foreground mb-4">Review Details</h2>
          {selectedReview ? (
            <ReviewDetailPanel review={selectedReview} />
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              <GitPullRequest className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a review from the list or trigger a new one.</p>
            </div>
          )}
        </div>
      </div>

      {/* Webhook Events (collapsible) */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setShowEvents(!showEvents)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-foreground/5 transition-colors"
        >
          <h2 className="text-lg font-semibold text-foreground">Webhook Events</h2>
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="text-sm">{events.length} events</span>
            {showEvents ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        </button>
        {showEvents && (
          <div className="px-6 pb-4 space-y-2 max-h-60 overflow-y-auto border-t border-border pt-4">
            {events.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-4">No webhook events yet.</div>
            ) : (
              events.map((item) => (
                <div key={item.id} className="flex items-center justify-between border border-border rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{item.eventType}</span>
                    <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${item.processed ? 'bg-success-100 text-success-700' : 'bg-warning-100 text-warning-700'}`}>
                    {item.processed ? 'processed' : 'pending'}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
