import { useMemo } from 'react';

interface CodeDiffProps {
  file: string;
  line?: number;
  context?: string;
  language?: string;
}

function getLineClass(line: string): string {
  if (line.startsWith('+')) return 'bg-green-500/10 text-green-700 dark:text-green-400';
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-700 dark:text-red-400';
  if (line.startsWith('@@')) return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium';
  return 'text-muted-foreground';
}

export default function CodeDiff({ file, line, context, language }: CodeDiffProps) {
  const diffLines = useMemo(() => {
    if (!context) return null;
    return context.split('\n').filter(Boolean);
  }, [context]);

  return (
    <div className="rounded-lg border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 border-b border-border">
        <span className="font-semibold text-foreground truncate">{file}</span>
        <div className="flex items-center gap-2 text-muted-foreground shrink-0">
          {language && <span className="uppercase text-[10px]">{language}</span>}
          {line && <span>Line {line}</span>}
        </div>
      </div>
      {diffLines ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <tbody>
              {diffLines.map((diffLine, idx) => (
                <tr key={idx} className={getLineClass(diffLine)}>
                  <td className="select-none text-right pr-2 pl-3 py-0 text-muted-foreground/50 w-8 border-r border-border/50">
                    {idx + 1}
                  </td>
                  <td className="pl-3 pr-4 py-0 whitespace-pre">{diffLine}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-3 py-2 text-muted-foreground italic">
          {file}{line ? `:${line}` : ''} — no code context available
        </div>
      )}
    </div>
  );
}
