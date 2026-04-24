import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EyebrowProps {
  children: ReactNode;
  prefix?: boolean;
  as?: ElementType;
  className?: string;
}

export function Eyebrow({ children, prefix = false, as: Tag = 'p', className }: EyebrowProps) {
  return (
    <Tag
      className={cn(
        'font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground',
        className
      )}
      data-testid="eyebrow"
    >
      {prefix ? (
        <>
          <span aria-hidden>§ </span>
          {children}
        </>
      ) : (
        children
      )}
    </Tag>
  );
}
