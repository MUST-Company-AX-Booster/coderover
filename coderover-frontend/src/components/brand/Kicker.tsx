import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type KickerStatus = 'live' | 'armed' | 'beta' | 'offline' | 'none';

const dotClass: Record<KickerStatus, string> = {
  live: 'bg-accent',
  armed: 'bg-accent',
  beta: 'bg-muted-foreground',
  offline: 'bg-muted-foreground/50',
  none: '',
};

export interface KickerProps {
  children: ReactNode;
  status?: KickerStatus;
  className?: string;
}

export function Kicker({ children, status = 'none', className }: KickerProps) {
  const showDot = status !== 'none';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-foreground/20 px-3 py-1',
        'font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground',
        className
      )}
      data-testid="kicker"
      data-status={status}
    >
      {showDot && (
        <span
          aria-hidden
          className={cn('block h-1.5 w-1.5 rounded-full', dotClass[status])}
          data-testid="kicker-dot"
        />
      )}
      {children}
    </span>
  );
}
