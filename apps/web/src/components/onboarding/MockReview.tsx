/**
 * A small, static review window for onboarding's theme step: top bar, file
 * tree, a diff with a thread under it, and the reading order, all drawn in
 * the chrome tokens, so it re-tints with the app when a theme is picked.
 * While a theme is only highlighted in the picker, its chrome is derived
 * onto this element alone (`applyDerivedChrome`'s target), so the preview
 * shows the whole window changing without touching the rest of the app.
 */
import { ArrowLeft, Bot, Check, ChevronDown, Columns2, MessageSquare, PanelLeft, PanelRight, Search, User } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { applyDerivedChrome, clearDerivedChrome } from '../../lib/deriveChrome.ts';
import { ThemeSample } from '../settings/ThemeSample.tsx';

const FILES: { name: string; depth: number; status?: 'A' | 'M'; viewed?: boolean }[] = [
  { name: 'src', depth: 0 },
  { name: 'greet.ts', depth: 1, status: 'M', viewed: true },
  { name: 'form.ts', depth: 1, status: 'M' },
  { name: 'test', depth: 0 },
  { name: 'greet.test.ts', depth: 1, status: 'A' },
];

const STEPS: { title: string; attention: 'focus' | 'skim'; current?: boolean }[] = [
  { title: 'Names get trimmed', attention: 'focus', current: true },
  { title: 'Form passes raw input', attention: 'skim' },
  { title: 'Tests', attention: 'skim' },
];

export function MockReview({ theme, preview }: { theme: string; preview: string | null }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (preview === null) {
      clearDerivedChrome(el);
      return;
    }
    let cancelled = false;
    applyDerivedChrome(preview, () => cancelled, el).catch(() => {
      if (!cancelled) clearDerivedChrome(el);
    });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none flex min-h-[260px] flex-1 select-none flex-col gap-1.5 overflow-hidden rounded-lg bg-chrome-bg-sunken p-1.5 text-chrome-fg ring-1 ring-chrome-border transition-colors duration-200"
    >
      <div className="chrome-island flex h-9 shrink-0 items-center gap-2 px-2.5 text-xs">
        <ArrowLeft size={13} strokeWidth={1.75} className="text-chrome-fg-muted" />
        <span className="text-chrome-fg-muted">web-app</span>
        <span className="text-chrome-fg-subtle">/</span>
        <span className="font-medium">feat/trim-names</span>
        <div className="ml-auto flex items-center gap-2 text-chrome-fg-muted">
          <Search size={13} strokeWidth={1.75} />
          <span className="flex items-center gap-0.5 text-micro font-medium">
            <span className="rounded-md bg-chrome-bg-active px-1.5 py-0.5 text-chrome-fg">Head</span>
            <span className="px-1.5 py-0.5">PR</span>
          </span>
          <Columns2 size={13} strokeWidth={1.75} />
          <MessageSquare size={13} strokeWidth={1.75} />
          <PanelLeft size={13} strokeWidth={1.75} />
          <PanelRight size={13} strokeWidth={1.75} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-1.5">
        <div className="chrome-island hidden w-40 shrink-0 flex-col gap-px p-2 text-xs sm:flex">
          <div className="flex items-baseline gap-1.5 px-1 pb-1.5">
            <span className="font-medium">Files</span>
            <span className="text-micro text-chrome-fg-subtle">3</span>
          </div>
          {FILES.map((f) => (
            <div key={f.name} className="flex h-6 items-center gap-1.5 rounded px-1" style={{ paddingLeft: 4 + f.depth * 14 }}>
              {f.status === undefined ? (
                <ChevronDown size={12} strokeWidth={1.75} className="text-chrome-fg-subtle" />
              ) : (
                <span className="w-3" />
              )}
              <span className={`min-w-0 flex-1 truncate ${f.status === 'A' ? 'text-chrome-success' : f.status === 'M' ? 'text-chrome-accent' : ''}`}>
                {f.name}
              </span>
              {f.viewed === true && <Check size={11} strokeWidth={2} className="text-chrome-fg-subtle" />}
              {f.status !== undefined && (
                <span className={`w-2.5 text-micro font-medium ${f.status === 'A' ? 'text-chrome-success' : 'text-chrome-accent'}`}>{f.status}</span>
              )}
            </div>
          ))}
        </div>

        <div className="chrome-island flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-chrome-border px-3 text-xs">
            <span className="truncate">src/greet.ts</span>
            <span className="ml-auto text-micro text-chrome-success tabular-nums">+2</span>
            <span className="text-micro text-chrome-danger tabular-nums">−1</span>
            <span className="flex items-center gap-1 text-micro text-chrome-fg-muted">
              <Check size={11} strokeWidth={2} />
              Viewed
            </span>
          </div>
          <ThemeSample name={preview ?? theme} framed={false} />
          <div className="mx-3 mt-1 mb-3 flex flex-col gap-2 rounded-md border border-chrome-border bg-chrome-bg-raised py-2">
            <Message agent={false} text="Why trim here and not where the form reads it?" />
            <Message agent text="Both call sites pass raw input, so trimming once here covers them." />
          </div>
        </div>

        <div className="chrome-island hidden w-48 shrink-0 flex-col gap-0.5 p-2 text-xs md:flex">
          <span className="px-1 pb-1.5 font-medium">Reading order</span>
          {STEPS.map((s, i) => (
            <div key={s.title} className="flex items-baseline gap-2 rounded-md px-1 py-1">
              <span className={`w-4 shrink-0 text-right font-mono text-micro tabular-nums ${s.current === true ? 'text-chrome-accent' : 'text-chrome-fg-subtle'}`}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
              <span
                className={`shrink-0 self-start rounded px-1 text-micro font-medium ${
                  s.attention === 'focus' ? 'bg-chrome-accent/15 text-chrome-accent' : 'bg-chrome-bg-hover text-chrome-fg-subtle'
                }`}
              >
                {s.attention === 'focus' ? 'Focus' : 'Skim'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Message({ agent, text }: { agent: boolean; text: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 px-2.5 text-xs">
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-full ${
          agent ? 'bg-chrome-accent-soft text-chrome-accent' : 'bg-chrome-bg-sunken text-chrome-fg-muted'
        }`}
      >
        {agent ? <Bot size={10} strokeWidth={1.75} /> : <User size={10} strokeWidth={1.75} />}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-micro font-medium">{agent ? 'Agent' : 'You'}</span>
        <span className="text-chrome-fg-muted">{text}</span>
      </div>
    </div>
  );
}
