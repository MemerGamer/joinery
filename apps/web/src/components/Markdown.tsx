/**
 * Comment markdown rendering (SPEC §8): `react-markdown` + `remark-gfm`, with
 * fenced code blocks highlighted through Pierre's shared Shiki highlighter
 * instance rather than pulling in a second highlighter.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSharedHighlighter } from '@pierre/diffs';
import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../state/ThemeContext.tsx';

function CodeBlock({
  className,
  children,
}: {
  className: string | undefined;
  children?: ReactNode;
}): React.JSX.Element {
  const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? 'text';
  const code = typeof children === 'string' ? children : String(children ?? '');
  const [html, setHtml] = useState<string | null>(null);
  const { chromeMode, diffTheme } = useTheme();
  const theme = chromeMode === 'dark' ? diffTheme.dark : diffTheme.light;

  useEffect(() => {
    let cancelled = false;
    getSharedHighlighter({ themes: [theme], langs: [lang] })
      .then((highlighter) => {
        if (cancelled) return;
        try {
          setHtml(highlighter.codeToHtml(code, { lang, theme }));
        } catch {
          setHtml(null);
        }
      })
      .catch(() => setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  if (html !== null) {
    // eslint-disable-next-line react/no-danger -- Shiki output, not user HTML.
    return <div className="thread-code-block text-xs" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre className="overflow-x-auto rounded bg-chrome-bg-sunken p-2 text-xs">
      <code>{code}</code>
    </pre>
  );
}

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="prose-sm max-w-none text-[13px] leading-relaxed text-chrome-fg [&_a]:text-chrome-accent [&_code]:text-[12px] [&_p]:my-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children: codeChildren }) {
            const isBlock = className?.includes('language-') ?? false;
            if (!isBlock) {
              return <code className="rounded bg-chrome-bg-sunken px-1 py-0.5">{codeChildren}</code>;
            }
            return <CodeBlock className={className}>{codeChildren}</CodeBlock>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
