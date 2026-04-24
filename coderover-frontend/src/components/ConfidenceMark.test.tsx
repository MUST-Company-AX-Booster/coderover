import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfidenceMark from './ConfidenceMark';

describe('ConfidenceMark', () => {
  describe('glyph rendering', () => {
    it('renders ⬤ for EXTRACTED on non-chat surfaces', () => {
      render(<ConfidenceMark tag="EXTRACTED" surface="graph" />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark).toBeInTheDocument();
      expect(mark.textContent).toContain('\u2B24');
      expect(mark).toHaveAttribute('aria-label', 'confidence: extracted');
    });

    it('renders ◐ for INFERRED with formatted score', () => {
      render(<ConfidenceMark tag="INFERRED" surface="chat" score={0.6} />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark.textContent).toContain('\u25D0');
      expect(mark.textContent).toContain('0.6');
      expect(mark).toHaveAttribute('aria-label', 'confidence: inferred, score 0.6');
    });

    it('renders ◯ for AMBIGUOUS without a score', () => {
      render(<ConfidenceMark tag="AMBIGUOUS" surface="graph" />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark.textContent).toContain('\u25EF');
      expect(mark).toHaveAttribute('aria-label', 'confidence: ambiguous');
    });
  });

  describe('chat-surface behavior', () => {
    it('EXTRACTED on chat is visually hidden (sr-only) but accessible', () => {
      const { container } = render(<ConfidenceMark tag="EXTRACTED" surface="chat" />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark).toHaveClass('sr-only');
      // Accessible text remains — screen readers can read it.
      expect(container.textContent).toContain('extracted');
    });

    it('INFERRED on chat renders visibly', () => {
      render(<ConfidenceMark tag="INFERRED" surface="chat" score={0.8} />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark).not.toHaveClass('sr-only');
      expect(mark.textContent).toContain('0.8');
    });

    it('AMBIGUOUS on chat always renders expandable', () => {
      render(<ConfidenceMark tag="AMBIGUOUS" surface="chat" />);
      expect(screen.getByTestId('confidence-why-trigger')).toBeInTheDocument();
    });
  });

  describe('score formatting', () => {
    it('formats 0.6 → "0.6"', () => {
      render(<ConfidenceMark tag="INFERRED" surface="pr" score={0.6} />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark.textContent).toContain('0.6');
    });

    it('clamps values above 1.0', () => {
      render(<ConfidenceMark tag="INFERRED" surface="pr" score={1.7} />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark.textContent).toContain('1.0');
    });

    it('null score on INFERRED renders "inferred · low confidence" suffix', () => {
      render(<ConfidenceMark tag="INFERRED" surface="pr" score={null} />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark.textContent).toContain('inferred');
      expect(mark.textContent).toContain('low confidence');
      expect(mark).toHaveAttribute('aria-label', 'confidence: inferred, low confidence');
    });

    it('undefined score on INFERRED renders low-confidence suffix', () => {
      render(<ConfidenceMark tag="INFERRED" surface="pr" />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark.textContent).toContain('low confidence');
    });
  });

  describe('why? accordion', () => {
    it('does not render accordion by default for EXTRACTED/INFERRED', () => {
      render(<ConfidenceMark tag="INFERRED" surface="pr" score={0.5} />);
      expect(screen.queryByTestId('confidence-why-trigger')).not.toBeInTheDocument();
    });

    it('expandable prop forces the trigger to render', () => {
      render(<ConfidenceMark tag="INFERRED" surface="pr" score={0.5} expandable />);
      expect(screen.getByTestId('confidence-why-trigger')).toBeInTheDocument();
    });

    it('AMBIGUOUS is always expandable', () => {
      render(<ConfidenceMark tag="AMBIGUOUS" surface="pr" />);
      expect(screen.getByTestId('confidence-why-trigger')).toBeInTheDocument();
    });

    it('toggles aria-expanded and reveals the panel', async () => {
      const user = userEvent.setup();
      render(<ConfidenceMark tag="AMBIGUOUS" surface="pr" />);
      const trigger = screen.getByTestId('confidence-why-trigger');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('confidence-why-panel')).not.toBeInTheDocument();

      await user.click(trigger);

      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('confidence-why-panel')).toBeInTheDocument();
      // Loading state shows skeleton since no whyContent provided.
      expect(screen.getByTestId('confidence-why-skeleton')).toBeInTheDocument();
    });

    it('collapses when toggled again', async () => {
      const user = userEvent.setup();
      render(<ConfidenceMark tag="AMBIGUOUS" surface="pr" />);
      const trigger = screen.getByTestId('confidence-why-trigger');
      await user.click(trigger);
      expect(screen.getByTestId('confidence-why-panel')).toBeInTheDocument();
      await user.click(trigger);
      expect(screen.queryByTestId('confidence-why-panel')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('calls onWhy when the accordion opens', () => {
      const onWhy = vi.fn();
      render(<ConfidenceMark tag="AMBIGUOUS" surface="pr" onWhy={onWhy} />);
      fireEvent.click(screen.getByTestId('confidence-why-trigger'));
      expect(onWhy).toHaveBeenCalledTimes(1);
    });

    it('renders custom whyContent when provided', () => {
      render(
        <ConfidenceMark
          tag="AMBIGUOUS"
          surface="pr"
          whyContent={<div data-testid="custom-evidence">producer: grep + AST</div>}
        />,
      );
      fireEvent.click(screen.getByTestId('confidence-why-trigger'));
      expect(screen.getByTestId('custom-evidence')).toBeInTheDocument();
      expect(screen.queryByTestId('confidence-why-skeleton')).not.toBeInTheDocument();
    });

    it('trigger is keyboard-focusable and activates on Enter', async () => {
      const user = userEvent.setup();
      render(<ConfidenceMark tag="AMBIGUOUS" surface="pr" />);
      await user.tab();
      const trigger = screen.getByTestId('confidence-why-trigger');
      expect(trigger).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('surface attribute', () => {
    it('exposes tag + surface as data attributes', () => {
      render(<ConfidenceMark tag="INFERRED" surface="graph" score={0.4} />);
      const mark = screen.getByTestId('confidence-mark');
      expect(mark).toHaveAttribute('data-tag', 'INFERRED');
      expect(mark).toHaveAttribute('data-surface', 'graph');
    });
  });
});
