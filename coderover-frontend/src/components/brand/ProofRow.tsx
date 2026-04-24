import { cn } from '@/lib/utils';

export interface ProofItem {
  label: string;
  value: string;
}

export interface ProofRowProps {
  items: ProofItem[];
  className?: string;
}

export function ProofRow({ items, className }: ProofRowProps) {
  return (
    <dl
      className={cn(
        'grid grid-cols-2 gap-x-8 gap-y-6 md:grid-cols-4',
        className
      )}
      data-testid="proof-row"
    >
      {items.map((item, i) => (
        <div key={`${i}-${item.label}`} className="flex flex-col gap-1">
          <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {item.label}
          </dt>
          <dd className="text-base font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
