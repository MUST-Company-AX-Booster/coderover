import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TerminalProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function Terminal({ title = '~/my-app — rover', children, className }: TerminalProps) {
  return (
    <div
      className={cn(
        'w-full overflow-hidden border border-border bg-card font-mono text-sm text-foreground',
        className
      )}
      role="group"
      aria-label="terminal"
      data-testid="terminal"
    >
      <div className="flex items-center gap-3 border-b border-border bg-background/40 px-3 py-2">
        <div className="flex gap-1.5" aria-hidden data-testid="terminal-dots">
          <span className="block h-2.5 w-2.5 rounded-full border border-muted-foreground/50" />
          <span className="block h-2.5 w-2.5 rounded-full border border-muted-foreground/50" />
          <span className="block h-2.5 w-2.5 rounded-full border border-muted-foreground/50" />
        </div>
        <span className="text-[11px] tracking-wider text-muted-foreground" data-testid="terminal-title">
          {title}
        </span>
      </div>
      <div className="overflow-x-auto px-4 py-3 leading-[1.75]">{children}</div>
    </div>
  );
}

export interface TerminalLineProps {
  children: ReactNode;
  prompt?: boolean;
  muted?: boolean;
  className?: string;
}

export function TerminalLine({ children, prompt, muted, className }: TerminalLineProps) {
  return (
    <div
      className={cn('whitespace-pre-wrap', muted && 'text-muted-foreground', className)}
      data-testid="terminal-line"
    >
      {prompt && (
        <span className="mr-2 select-none text-muted-foreground" aria-hidden>
          $
        </span>
      )}
      {children}
    </div>
  );
}

export function TerminalToken({
  children,
  tone = 'bone',
  className,
}: {
  children: ReactNode;
  tone?: 'bone' | 'silver' | 'accent' | 'destructive' | 'warning';
  className?: string;
}) {
  const toneClass = {
    bone: 'text-foreground',
    silver: 'text-muted-foreground',
    accent: 'text-accent',
    destructive: 'text-destructive',
    warning: 'text-warning-500',
  }[tone];
  return <span className={cn(toneClass, className)}>{children}</span>;
}
