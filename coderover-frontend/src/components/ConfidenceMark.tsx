import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Phase 10 B3 — shared confidence mark.
 *
 * Design locked by /plan-design-review 2026-04-17:
 *   ⬤ EXTRACTED  — slate-500, no number, invisible by default on chat citations
 *   ◐ INFERRED   — amber-500, shows score
 *   ◯ AMBIGUOUS  — rose-500, no number, always expandable
 *
 * Shape (solid / half / hollow) carries the signal. Color is supplementary —
 * the component is legible in grayscale and for colorblind users. No gradients,
 * no glow, no pulse, no sparkle, no emoji, no purple.
 */

export type ConfidenceTag = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
export type ConfidenceSurface = 'chat' | 'graph' | 'pr';

export interface ConfidenceMarkProps {
  tag: ConfidenceTag;
  score?: number | null;
  surface: ConfidenceSurface;
  /**
   * When true, the mark exposes a "why?" inline affordance. AMBIGUOUS is
   * always expandable regardless of this flag.
   */
  expandable?: boolean;
  /**
   * Handler invoked when the user opens the "why?" accordion. Parent can
   * use this to lazy-fetch evidence (B4 endpoint).
   */
  onWhy?: () => void;
  /** Optional extra content rendered inside the accordion. */
  whyContent?: ReactNode;
  /** Optional class for the outer wrapper. */
  className?: string;
}

const GLYPH: Record<ConfidenceTag, string> = {
  EXTRACTED: '\u2B24', // ⬤ solid
  INFERRED: '\u25D0', // ◐ half
  AMBIGUOUS: '\u25EF', // ◯ hollow
};

// Tailwind tokens (slate/amber/rose at 500). Readable on light + dark.
const COLOR: Record<ConfidenceTag, string> = {
  EXTRACTED: 'text-slate-500',
  INFERRED: 'text-amber-500',
  AMBIGUOUS: 'text-rose-500',
};

const TAG_LABEL: Record<ConfidenceTag, string> = {
  EXTRACTED: 'extracted',
  INFERRED: 'inferred',
  AMBIGUOUS: 'ambiguous',
};

function formatScore(score: number | null | undefined): string | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  // Clamp + format to 1 decimal, matching the design spec ("0.6").
  const clamped = Math.max(0, Math.min(1, score));
  return clamped.toFixed(1);
}

function buildAriaLabel(tag: ConfidenceTag, score: number | null | undefined): string {
  const label = TAG_LABEL[tag];
  const fmt = formatScore(score);
  if (tag === 'INFERRED') {
    return fmt
      ? `confidence: ${label}, score ${fmt}`
      : `confidence: ${label}, low confidence`;
  }
  return `confidence: ${label}`;
}

export function ConfidenceMark({
  tag,
  score = null,
  surface,
  expandable = false,
  onWhy,
  whyContent,
  className,
}: ConfidenceMarkProps) {
  // AMBIGUOUS is always expandable per the plan.
  const isExpandable = expandable || tag === 'AMBIGUOUS';

  // Per plan: EXTRACTED on chat stays invisible by default — but must remain
  // accessible to screen readers.
  const isHiddenOnChat = tag === 'EXTRACTED' && surface === 'chat';

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const reactId = useId();
  const panelId = `cm-panel-${reactId}`;

  const handleToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next) onWhy?.();
  }, [open, onWhy]);

  // Return focus to the trigger only on *collapse*, not initial mount, so
  // the accordion is keyboard-navigable without stealing focus on page load.
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      buttonRef.current?.focus({ preventScroll: true });
    }
    wasOpenRef.current = open;
  }, [open]);

  const glyph = GLYPH[tag];
  const color = COLOR[tag];
  const ariaLabel = buildAriaLabel(tag, score);
  const fmtScore = formatScore(score);

  // INFERRED with null score: no number suffix, mark reads "inferred · low confidence".
  const suffix: string | null =
    tag === 'INFERRED'
      ? fmtScore
        ? fmtScore
        : null
      : null;

  const inferredNoScore = tag === 'INFERRED' && !fmtScore;

  // Surface-specific layout knobs.
  const isPR = surface === 'pr';

  // Invisible-on-chat case: render an sr-only span so the info is still
  // available to assistive tech but doesn't clutter the UI.
  if (isHiddenOnChat && !isExpandable) {
    return (
      <span className={cn('sr-only', className)} data-testid="confidence-mark" data-tag={tag} data-surface={surface}>
        {ariaLabel}
      </span>
    );
  }

  const glyphEl = (
    <span
      aria-hidden="true"
      className={cn('inline-block leading-none', color)}
      style={{ fontSize: '12px', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
    >
      {glyph}
    </span>
  );

  const scoreEl = suffix ? (
    <span
      aria-hidden="true"
      className={cn('ml-1 tabular-nums text-[11px] text-muted-foreground')}
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      {suffix}
    </span>
  ) : null;

  const lowConfidenceEl = inferredNoScore ? (
    <span className="ml-1 italic text-[11px] text-muted-foreground">
      inferred · low confidence
    </span>
  ) : null;

  const markInline = (
    <span
      className={cn('inline-flex items-center align-baseline', isPR && 'mr-1.5')}
      role="img"
      aria-label={ariaLabel}
      data-testid="confidence-mark"
      data-tag={tag}
      data-surface={surface}
    >
      {glyphEl}
      {scoreEl}
      {lowConfidenceEl}
    </span>
  );

  if (!isExpandable) {
    return <span className={cn('inline-flex items-center', className)}>{markInline}</span>;
  }

  return (
    <span className={cn('inline-flex flex-col items-start', className)}>
      <span className="inline-flex items-center gap-1">
        {markInline}
        <button
          ref={buttonRef}
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            'text-[11px] italic text-muted-foreground underline-offset-2 hover:underline',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm',
          )}
          data-testid="confidence-why-trigger"
        >
          why?
        </button>
      </span>
      {open && (
        <span
          id={panelId}
          role="region"
          aria-label="confidence evidence"
          className={cn(
            'mt-1 block w-full max-w-md overflow-hidden rounded-md border border-border bg-card px-3 py-2',
            'text-[12px] text-foreground',
            // 200ms ease-out expand — plan-locked.
            'transition-[max-height,opacity] duration-200 ease-out',
          )}
          data-testid="confidence-why-panel"
        >
          {whyContent ?? <EvidenceLoadingSkeleton />}
        </span>
      )}
    </span>
  );
}

/**
 * Skeleton shown while B4's POST /citations/evidence is in flight. Keeps
 * the layout stable so the accordion doesn't pop when real data arrives.
 * Uses spans (not divs) so it nests safely inside inline-level mark wrappers.
 */
function EvidenceLoadingSkeleton() {
  return (
    <span
      className="flex flex-col gap-1.5"
      role="status"
      aria-live="polite"
      data-testid="confidence-why-skeleton"
    >
      <span className="text-[11px] text-muted-foreground">loading...</span>
      <span className="block h-2 w-3/4 rounded bg-foreground/10" />
      <span className="block h-2 w-1/2 rounded bg-foreground/10" />
    </span>
  );
}

export default ConfidenceMark;
