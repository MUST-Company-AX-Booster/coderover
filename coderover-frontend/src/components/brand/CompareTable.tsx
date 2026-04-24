import { cn } from '@/lib/utils';

export type CompareCell = string | { value: string; highlight?: boolean };

export interface CompareRow {
  feature: string;
  cells: CompareCell[];
}

export interface CompareTableProps {
  columns: string[];
  highlightColumnIndex?: number;
  rows: CompareRow[];
  className?: string;
}

function cellValue(cell: CompareCell): string {
  return typeof cell === 'string' ? cell : cell.value;
}
function cellHighlighted(cell: CompareCell): boolean {
  return typeof cell === 'object' && !!cell.highlight;
}

export function CompareTable({ columns, rows, highlightColumnIndex, className }: CompareTableProps) {
  return (
    <div className={cn('w-full overflow-x-auto', className)} data-testid="compare-table">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="p-3 text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground" />
            {columns.map((col, i) => (
              <th
                key={col}
                className={cn(
                  'p-3 text-left font-mono text-[11px] uppercase tracking-[0.18em]',
                  i === highlightColumnIndex ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={`${rIdx}-${row.feature}`} className="border-b border-border last:border-b-0">
              <th className="p-3 text-left align-top font-normal text-foreground">{row.feature}</th>
              {row.cells.map((cell, cIdx) => {
                const isUs = cIdx === highlightColumnIndex;
                const isYes = cellValue(cell) !== '—' && cellValue(cell) !== '';
                return (
                  <td
                    key={cIdx}
                    className={cn(
                      'p-3 align-top font-mono text-xs',
                      isUs && 'text-foreground',
                      !isUs && isYes && 'text-foreground/80',
                      !isUs && !isYes && 'text-muted-foreground/60',
                      (isUs || cellHighlighted(cell)) && 'text-accent'
                    )}
                  >
                    {cellValue(cell) || '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
