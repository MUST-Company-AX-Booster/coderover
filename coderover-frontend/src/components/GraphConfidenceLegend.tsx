import type { EdgeConfidenceTag } from '@/lib/api/graph';

/**
 * Phase 10 B3 — graph-edge style system (plan-locked 2026-04-17):
 *   color = relation kind (owned by caller)
 *   style = confidence (solid / dashed / dotted)
 *   opacity = score (below 0.5 fades to 0.5; null = 1.0 for EXTRACTED, else 0.5)
 *
 * Legacy untagged edges are treated as AMBIGUOUS so they remain visible but
 * clearly low-confidence.
 */

export const EDGE_STYLE_BY_TAG: Record<EdgeConfidenceTag, string | undefined> = {
  EXTRACTED: undefined, // solid
  INFERRED: '6 4',      // dashed
  AMBIGUOUS: '2 3',     // dotted
};

/** Returns a `strokeDasharray` suitable for ReactFlow's `style` prop. */
export function dashArrayFor(tag: EdgeConfidenceTag): string | undefined {
  return EDGE_STYLE_BY_TAG[tag];
}

export function opacityFor(tag: EdgeConfidenceTag, score: number | null | undefined): number {
  if (score == null) return tag === 'EXTRACTED' ? 1.0 : 0.5;
  const clamped = Math.max(0, Math.min(1, score));
  return clamped < 0.5 ? 0.5 : clamped;
}

export function normalizeEdgeTag(raw: unknown): EdgeConfidenceTag {
  if (raw === 'EXTRACTED' || raw === 'INFERRED' || raw === 'AMBIGUOUS') return raw;
  return 'AMBIGUOUS';
}

/** Legend component shown next to the graph. */
export function GraphConfidenceLegend() {
  const items: Array<{ tag: EdgeConfidenceTag; label: string; dash: string | undefined }> = [
    { tag: 'EXTRACTED', label: 'Extracted', dash: undefined },
    { tag: 'INFERRED', label: 'Inferred', dash: EDGE_STYLE_BY_TAG.INFERRED },
    { tag: 'AMBIGUOUS', label: 'Ambiguous', dash: EDGE_STYLE_BY_TAG.AMBIGUOUS },
  ];

  return (
    <div
      className="absolute top-3 right-3 z-10 rounded-md border border-border bg-card/90 backdrop-blur px-3 py-2 text-[11px] shadow-sm"
      data-testid="graph-confidence-legend"
    >
      <p className="font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        Confidence
      </p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.tag} className="flex items-center gap-2">
            <svg width="28" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="28"
                y2="4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray={it.dash}
                className="text-foreground"
              />
            </svg>
            <span className="text-foreground">{it.label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-muted-foreground italic">
        color = relation \u00B7 opacity = score
      </p>
    </div>
  );
}

export default GraphConfidenceLegend;
