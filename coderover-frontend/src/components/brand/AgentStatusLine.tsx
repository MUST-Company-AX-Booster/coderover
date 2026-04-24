import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AgentName = 'scout' | 'tinker' | 'sentinel' | 'beacon' | 'archive';
export type StatusLevel = 'ok' | 'warn' | 'block' | 'pending';

export interface AgentStatusLineProps {
  agent: AgentName;
  level?: StatusLevel;
  levelText?: string;
  children: ReactNode;
  className?: string;
}

const levelToken: Record<StatusLevel, { label: string; tone: string }> = {
  ok: { label: 'OK', tone: 'text-accent' },
  warn: { label: 'WARN', tone: 'text-warning-500' },
  block: { label: 'BLOCK', tone: 'text-destructive' },
  pending: { label: 'PENDING', tone: 'text-muted-foreground' },
};

export function AgentStatusLine({
  agent,
  level,
  levelText,
  children,
  className,
}: AgentStatusLineProps) {
  const displayLevel = level ? (levelText ?? levelToken[level].label) : null;
  return (
    <div
      className={cn(
        'flex flex-wrap items-baseline gap-2 font-mono text-sm',
        className
      )}
      data-testid="agent-status-line"
      data-agent={agent}
      data-level={level ?? 'none'}
    >
      <span className="text-muted-foreground">[{agent}]</span>
      {displayLevel && (
        <span className={cn('font-medium', levelToken[level!].tone)}>
          {displayLevel}
        </span>
      )}
      <span className="text-foreground/90">{children}</span>
    </div>
  );
}
