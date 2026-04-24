import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  GraphConfidenceLegend,
  dashArrayFor,
  opacityFor,
  normalizeEdgeTag,
} from './GraphConfidenceLegend';

describe('graph edge confidence helpers', () => {
  describe('dashArrayFor', () => {
    it('returns undefined (solid) for EXTRACTED', () => {
      expect(dashArrayFor('EXTRACTED')).toBeUndefined();
    });
    it('returns a dash pattern for INFERRED', () => {
      expect(dashArrayFor('INFERRED')).toBe('6 4');
    });
    it('returns a dot pattern for AMBIGUOUS', () => {
      expect(dashArrayFor('AMBIGUOUS')).toBe('2 3');
    });
  });

  describe('opacityFor', () => {
    it('returns 1.0 for EXTRACTED with null score', () => {
      expect(opacityFor('EXTRACTED', null)).toBe(1.0);
    });
    it('returns 0.5 for INFERRED with null score', () => {
      expect(opacityFor('INFERRED', null)).toBe(0.5);
    });
    it('returns 0.5 for AMBIGUOUS with null score', () => {
      expect(opacityFor('AMBIGUOUS', null)).toBe(0.5);
    });
    it('fades scores below 0.5 to a 0.5 floor', () => {
      expect(opacityFor('INFERRED', 0.2)).toBe(0.5);
    });
    it('returns score directly for values ≥ 0.5', () => {
      expect(opacityFor('INFERRED', 0.8)).toBe(0.8);
    });
    it('clamps values above 1.0', () => {
      expect(opacityFor('INFERRED', 1.5)).toBe(1.0);
    });
  });

  describe('normalizeEdgeTag', () => {
    it('passes through valid tags', () => {
      expect(normalizeEdgeTag('EXTRACTED')).toBe('EXTRACTED');
      expect(normalizeEdgeTag('INFERRED')).toBe('INFERRED');
      expect(normalizeEdgeTag('AMBIGUOUS')).toBe('AMBIGUOUS');
    });
    it('treats legacy/unknown values as AMBIGUOUS', () => {
      expect(normalizeEdgeTag(undefined)).toBe('AMBIGUOUS');
      expect(normalizeEdgeTag(null)).toBe('AMBIGUOUS');
      expect(normalizeEdgeTag('unknown')).toBe('AMBIGUOUS');
    });
  });
});

describe('GraphConfidenceLegend', () => {
  it('renders all three tag labels', () => {
    render(<GraphConfidenceLegend />);
    expect(screen.getByTestId('graph-confidence-legend')).toBeInTheDocument();
    expect(screen.getByText('Extracted')).toBeInTheDocument();
    expect(screen.getByText('Inferred')).toBeInTheDocument();
    expect(screen.getByText('Ambiguous')).toBeInTheDocument();
  });

  it('explains both channels', () => {
    render(<GraphConfidenceLegend />);
    // color = relation · opacity = score
    expect(screen.getByText(/color = relation/)).toBeInTheDocument();
    expect(screen.getByText(/opacity = score/)).toBeInTheDocument();
  });
});
