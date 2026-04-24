import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type RoverName = 'Scout' | 'Tinker' | 'Sentinel' | 'Beacon' | 'Archive';
export type RoverStatus = 'online' | 'armed' | 'patrolling' | 'offline' | 'pending';

export interface RoverBadgeProps {
  unit: 1 | 2 | 3 | 4 | 5;
  name: RoverName;
  role: string;
  status?: RoverStatus;
  children?: ReactNode;
  className?: string;
}

const statusColor: Record<RoverStatus, string> = {
  online: 'bg-accent',
  armed: 'bg-accent',
  patrolling: 'bg-accent',
  offline: 'bg-muted-foreground/40',
  pending: 'bg-muted-foreground',
};

const statusText: Record<RoverStatus, string> = {
  online: 'text-accent',
  armed: 'text-accent',
  patrolling: 'text-accent',
  offline: 'text-muted-foreground',
  pending: 'text-muted-foreground',
};

function formatUnit(n: number) {
  return `Unit ${String(n).padStart(2, '0')}`;
}

export function RoverBadge({
  unit,
  name,
  role,
  status = 'online',
  children,
  className,
}: RoverBadgeProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border border-border bg-card p-4',
        className
      )}
      data-testid="rover-badge"
      data-rover={name.toLowerCase()}
      data-status={status}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {formatUnit(unit)}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em]',
            statusText[status]
          )}
        >
          <span
            aria-hidden
            className={cn('h-1.5 w-1.5 rounded-full', statusColor[status])}
            data-testid="rover-status-dot"
          />
          {status}
        </span>
      </div>
      <div>
        <h4 className="text-lg font-medium text-foreground">{name}</h4>
        <p className="font-mono text-xs text-muted-foreground">{role}</p>
      </div>
      {children && <div className="text-sm text-foreground/80">{children}</div>}
    </div>
  );
}
