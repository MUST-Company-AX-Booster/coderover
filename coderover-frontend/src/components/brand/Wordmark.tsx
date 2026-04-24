import { cn } from '@/lib/utils';

const sizeClass = {
  sm: 'text-2xl',
  md: 'text-5xl',
  lg: 'text-[clamp(4rem,10vw,12rem)] leading-[0.88]',
} as const;

export interface WordmarkProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  text?: string;
  glow?: boolean;
}

export function Wordmark({ size = 'md', className, text = 'CODEROVER', glow = true }: WordmarkProps) {
  return (
    <span
      className={cn(
        'inline-block font-normal tracking-[0.02em] text-foreground',
        sizeClass[size],
        className
      )}
      style={{
        fontFamily: '"Bokeh", "Cormorant Garamond", serif',
        ...(glow && {
          textShadow:
            '0 0 40px rgba(237, 235, 229, 0.35), 0 0 80px rgba(237, 235, 229, 0.18), 0 0 140px rgba(237, 235, 229, 0.08)',
        }),
      }}
      aria-label={text}
      data-testid="wordmark"
    >
      {text}
    </span>
  );
}
