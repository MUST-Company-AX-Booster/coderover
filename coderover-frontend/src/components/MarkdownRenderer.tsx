import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-sm max-w-none ${className || ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return (
              <pre className="rounded-lg bg-foreground/5 p-3 text-xs text-muted-foreground overflow-x-auto">
                {children}
              </pre>
            );
          },
          code({ className: codeClassName, children, ...props }) {
            const isBlock = codeClassName?.startsWith('language-');
            if (isBlock) {
              const lang = codeClassName?.replace('language-', '') || '';
              return (
                <>
                  {lang && <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">{lang}</div>}
                  <code className="font-mono whitespace-pre" {...props}>{children}</code>
                </>
              );
            }
            return (
              <code className="rounded bg-foreground/15 px-1.5 py-0.5 font-mono text-xs text-foreground" {...props}>
                {children}
              </code>
            );
          },
          h1({ children }) {
            return <div className="text-xl font-semibold text-foreground">{children}</div>;
          },
          h2({ children }) {
            return <div className="text-lg font-semibold text-foreground">{children}</div>;
          },
          h3({ children }) {
            return <div className="text-base font-semibold text-foreground">{children}</div>;
          },
          h4({ children }) {
            return <div className="text-sm font-semibold text-foreground">{children}</div>;
          },
          p({ children }) {
            return <p className="text-sm leading-6 text-foreground">{children}</p>;
          },
          ul({ children }) {
            return <ul className="list-disc pl-5 space-y-1">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal pl-5 space-y-1">{children}</ol>;
          },
          li({ children }) {
            return <li className="text-sm text-foreground">{children}</li>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-primary-300 bg-primary-50 px-3 py-2 text-sm text-foreground">
                {children}
              </blockquote>
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary-700 underline underline-offset-2 hover:text-primary-800"
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm border border-border rounded-lg">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-foreground/10">{children}</thead>;
          },
          th({ children }) {
            return <th className="px-3 py-2 text-left font-medium text-foreground border-b border-border">{children}</th>;
          },
          td({ children }) {
            return <td className="px-3 py-2 text-muted-foreground border-b border-border">{children}</td>;
          },
          hr() {
            return <hr className="border-border my-4" />;
          },
          strong({ children }) {
            return <strong className="font-semibold">{children}</strong>;
          },
          em({ children }) {
            return <em className="italic">{children}</em>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
