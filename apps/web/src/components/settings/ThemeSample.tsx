/**
 * A few lines of diff drawn in one named theme, whichever theme is active,
 * so the settings page can show the dark and the light pick side by side.
 * The diff view itself can't do that: its worker pool renders in one theme
 * at a time. This tokenizes with Shiki on the main thread instead, loaded on
 * first use so it stays out of the main bundle.
 */
import type { ThemeLike } from '@pierre/theming';
import { themes as allThemes } from '@pierre/theming/themes';
import { useEffect, useState } from 'react';
import type { ThemeRegistrationAny } from 'shiki';

const LINES: { kind: 'context' | 'removed' | 'added'; text: string }[] = [
  { kind: 'context', text: 'export function greet(name: string): string {' },
  { kind: 'removed', text: "  return 'Hello, ' + name;" },
  { kind: 'added', text: '  const trimmed = name.trim();' },
  { kind: 'added', text: '  return `Hello, ${trimmed}!`; // 2 changes' },
  { kind: 'context', text: '}' },
];

type Token = { content: string; color?: string | undefined };
type Rendered = { lines: Token[][]; bg: string; fg: string; added: string; removed: string };

async function render(name: string): Promise<Rendered | null> {
  const descriptor = allThemes.getTheme(name);
  if (descriptor === undefined) return null;
  const [{ codeToTokens }, loaded] = await Promise.all([import('shiki'), descriptor.load()]);
  // Loaders may resolve to the theme itself or to an ES module wrapping it.
  const theme: ThemeLike = 'default' in loaded ? loaded.default : loaded;
  const colors = theme.colors ?? {};
  const result = await codeToTokens(LINES.map((l) => l.text).join('\n'), {
    lang: 'typescript',
    // A Pierre/Shiki theme object, which is what Shiki takes as a theme registration.
    theme: theme as ThemeRegistrationAny,
  });
  return {
    lines: result.tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color }))),
    bg: result.bg ?? theme.bg ?? colors['editor.background'] ?? 'transparent',
    fg: result.fg ?? theme.fg ?? colors['editor.foreground'] ?? 'inherit',
    added: colors['diffEditor.insertedLineBackground'] ?? 'rgba(46, 160, 67, 0.18)',
    removed: colors['diffEditor.removedLineBackground'] ?? 'rgba(248, 81, 73, 0.18)',
  };
}

export function ThemeSample({ name }: { name: string }): React.JSX.Element {
  const [state, setState] = useState<{ name: string; rendered: Rendered | null } | null>(null);

  useEffect(() => {
    let live = true;
    render(name)
      .then((rendered) => {
        if (live) setState({ name, rendered });
      })
      .catch(() => {
        if (live) setState({ name, rendered: null });
      });
    return () => {
      live = false;
    };
  }, [name]);

  const rendered = state?.rendered ?? null;
  // Keeps the last sample on screen (dimmed) while the next theme loads.
  const stale = state === null || state.name !== name;
  return (
    <div
      className={`overflow-hidden rounded-md border border-chrome-border font-mono text-[11.5px] leading-[19px] transition-opacity ${stale ? 'opacity-60' : ''}`}
      style={{ background: rendered?.bg, color: rendered?.fg }}
      aria-hidden
    >
      <div className="py-1.5">
        {LINES.map((line, i) => (
          <div
            key={i}
            className="flex whitespace-pre"
            style={{
              background: line.kind === 'added' ? rendered?.added : line.kind === 'removed' ? rendered?.removed : undefined,
            }}
          >
            <span className="w-6 shrink-0 text-center opacity-50">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
            </span>
            <span className="min-w-0 truncate pr-3">
              {rendered === null
                ? line.text
                : (rendered.lines[i] ?? []).map((t, j) => (
                    <span key={j} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
