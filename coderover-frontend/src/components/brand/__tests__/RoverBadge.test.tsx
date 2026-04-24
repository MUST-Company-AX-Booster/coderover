import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoverBadge } from '../RoverBadge';

describe('RoverBadge', () => {
  it('renders Unit ## zero-padded, name, and role', () => {
    render(<RoverBadge unit={1} name="Scout" role="pr-review agent" />);
    expect(screen.getByText('Unit 01')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('pr-review agent')).toBeInTheDocument();
  });

  it('renders optional child description', () => {
    render(
      <RoverBadge unit={3} name="Sentinel" role="security agent">
        Patrols for hardcoded secrets.
      </RoverBadge>
    );
    expect(screen.getByText('Patrols for hardcoded secrets.')).toBeInTheDocument();
  });

  it('exposes status and rover via data attributes for targeting', () => {
    render(<RoverBadge unit={5} name="Archive" role="decision-memory agent" status="online" />);
    const badge = screen.getByTestId('rover-badge');
    expect(badge).toHaveAttribute('data-rover', 'archive');
    expect(badge).toHaveAttribute('data-status', 'online');
  });

  it('uses accent dot for active statuses (online, armed, patrolling)', () => {
    const statuses: Array<'online' | 'armed' | 'patrolling'> = ['online', 'armed', 'patrolling'];
    for (const s of statuses) {
      const { unmount } = render(
        <RoverBadge unit={2} name="Tinker" role="refactor agent" status={s} />
      );
      expect(screen.getByTestId('rover-status-dot')).toHaveClass('bg-accent');
      unmount();
    }
  });

  it('uses muted dot for offline status', () => {
    render(<RoverBadge unit={4} name="Beacon" role="health-report agent" status="offline" />);
    expect(screen.getByTestId('rover-status-dot').className).toMatch(/bg-muted-foreground/);
  });

  it('defaults status to online when not provided', () => {
    render(<RoverBadge unit={1} name="Scout" role="pr-review agent" />);
    expect(screen.getByTestId('rover-badge')).toHaveAttribute('data-status', 'online');
  });
});
