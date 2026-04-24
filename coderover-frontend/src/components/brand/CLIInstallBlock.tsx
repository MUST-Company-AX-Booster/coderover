import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface CLIInstallBlockProps {
  command: string;
  className?: string;
}

export function CLIInstallBlock({ command, className }: CLIInstallBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={cn(
        'inline-flex max-w-full items-stretch border border-foreground/20 bg-foreground/[0.03] font-mono text-sm',
        className
      )}
      data-testid="cli-install-block"
    >
      <span
        className="flex select-none items-center border-r border-foreground/20 px-3 text-muted-foreground"
        aria-hidden
      >
        $
      </span>
      <code className="flex items-center overflow-x-auto whitespace-nowrap px-3 py-2 text-foreground">
        {command}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        className={cn(
          'flex select-none items-center border-l border-foreground/20 px-3 text-[11px] uppercase tracking-[0.18em]',
          'text-muted-foreground transition-colors hover:bg-foreground hover:text-background',
          copied && 'bg-accent text-background hover:bg-accent'
        )}
        data-testid="cli-install-copy"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
