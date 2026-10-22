/**
 * The peek window: a symbol's definition and uses on the left, the chosen
 * file on the right, IDE-style.
 *
 * - The definition is listed first and shown as soon as it's found; uses
 *   fill in below when the server has looked them up, files this review
 *   changes first.
 * - Clicking a file shows it at its first use, clicking a use at that line;
 *   ↑/↓ step through the list.
 * - The preview is the whole file, highlighted like the diff, with hover and
 *   ⌘-click of its own: ⌘-clicking a name re-targets the window to it, and
 *   ‹ › (⌘[ ⌘]) walk back and forth through those steps.
 * - "Go to it in this review" leaves for the diff when the file is changed.
 *
 * While nothing has been found yet it stays a one-line status, sized to it.
 */
import { File as CodeFile } from '@pierre/diffs/react';
import type { TokenEventBase } from '@pierre/diffs';
import type { LspDefinition, LspFile, LspReference, LspReferences } from '@joinery/core';
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { PREFERRED_HIGHLIGHTER } from '../lib/workerPool.tsx';
import { useTheme } from '../state/ThemeContext.tsx';
import { cached, CODE_INTEL_CSS, IS_MAC, placement } from '../lib/codeIntel.ts';

const WIDTH = 1_080;
const HEIGHT = 520;
const STATUS_WIDTH = 360;

export type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string };

/** One step of the window's history: a symbol, what was found for it, and what's shown. */
export type NavEntry = {
  readonly id: number;
  readonly name: string;
  definition: Load<LspDefinition | null>;
  references: Load<LspReferences | null>;
  /** The file and line on the right: the definition's, or else the first use's, once in. */
  selected: { ref: string; line: number } | null;
};

export type Nav = { rect: DOMRect; entries: NavEntry[]; index: number };

type PreviewHandlers = {
  onTokenEnter: (props: TokenEventBase, event: PointerEvent, file: LspFile) => void;
  onTokenLeave: (props: TokenEventBase) => void;
  onTokenClick: (props: TokenEventBase, event: MouseEvent, file: LspFile) => void;
};

const fileCache = new Map<string, Promise<LspFile | null>>();

/** The file to preview: the definition's text when that's the one, else fetched once per review. */
function usePreviewFile(reviewId: string, ref: string | null, definition: LspDefinition | null): Load<LspFile | null> | null {
  const inline = ref !== null && definition?.ref === ref ? definition : null;
  const [fetched, setFetched] = useState<{ ref: string; load: Load<LspFile | null> } | null>(null);
  useEffect(() => {
    if (ref === null || inline !== null) return;
    let live = true;
    setFetched({ ref, load: { status: 'loading' } });
    cached(fileCache, `${reviewId}:${ref}`, () => callApi('getLspFile', { params: [reviewId], query: { path: ref } }).then((r) => r.file)).then(
      (file) => live && setFetched({ ref, load: { status: 'ready', value: file } }),
      (err: unknown) =>
        live && setFetched({ ref, load: { status: 'error', message: err instanceof Error ? err.message : String(err) } }),
    );
    return () => {
      live = false;
    };
  }, [reviewId, ref, inline]);
  if (ref === null) return null;
  if (inline !== null) return { status: 'ready', value: inline };
  return fetched?.ref === ref ? fetched.load : { status: 'loading' };
}

type FileGroup = { ref: string; path: string; inReview: boolean; uses: LspReference[] };

function groupByFile(references: readonly LspReference[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const r of references) {
    let group = groups.get(r.ref);
    if (group === undefined) {
      group = { ref: r.ref, path: r.path, inReview: r.inReview, uses: [] };
      groups.set(r.ref, group);
    }
    group.uses.push(r);
  }
  return Array.from(groups.values());
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), dir: slash < 0 ? '' : path.slice(0, slash) };
}

function loadError(load: Load<unknown>): string | null {
  return load.status === 'error' ? load.message : null;
}

export function PeekNavigator({
  nav,
  reviewId,
  preview,
  onSelect,
  onStep,
  onJump,
  onClose,
}: {
  nav: Nav;
  reviewId: string;
  preview: PreviewHandlers;
  onSelect: (selected: { ref: string; line: number }) => void;
  onStep: (delta: 1 | -1) => void;
  onJump: (path: string, line: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const entry = nav.entries[nav.index];
  const definition = entry?.definition.status === 'ready' ? entry.definition.value : null;
  const references = entry?.references.status === 'ready' ? (entry.references.value?.references ?? []) : [];
  const selected = entry?.selected ?? null;

  // Everything the list can select, in order, for ↑/↓.
  const stops = useMemo(() => {
    const all: { ref: string; line: number }[] = definition === null ? [] : [{ ref: definition.ref, line: definition.line }];
    return all.concat(references.map((r) => ({ ref: r.ref, line: r.line })));
  }, [definition, references]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (e.key === 'Escape') onClose();
      else if (mod && (e.key === '[' || e.key === ']')) onStep(e.key === '[' ? -1 : 1);
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && stops.length > 0) {
        const at = stops.findIndex((s) => s.ref === selected?.ref && s.line === selected.line);
        const next = stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next !== undefined) onSelect(next);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target) === true || target?.closest?.('[data-code-intel]') != null) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, onSelect, onStep, selected, stops]);

  if (entry === undefined) return <></>;

  // Nothing to show yet on the first step: a status line, not an empty window.
  const found = definition !== null || references.length > 0;
  if (!found && nav.entries.length === 1) {
    const error = loadError(entry.definition) ?? loadError(entry.references);
    const status =
      entry.definition.status === 'loading'
        ? 'Finding the definition…'
        : entry.references.status === 'loading'
          ? 'Finding uses…'
          : error !== null
            ? `Couldn't look it up: ${error}`
            : `Nothing found for ${entry.name}`;
    const width = Math.min(STATUS_WIDTH, window.innerWidth - 16);
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label="Definition and uses"
        data-code-intel=""
        style={{ ...placement(nav.rect, width, 40), maxWidth: width }}
        className="fixed z-50 flex h-8 items-center gap-2 overflow-hidden rounded-md bg-chrome-bg-raised pl-3 pr-1 text-xs shadow-chrome ring-1 ring-chrome-fg/10"
      >
        <span className="truncate text-chrome-fg-muted">{status}</span>
        <CloseButton onClose={onClose} />
      </div>
    );
  }

  const width = Math.min(WIDTH, window.innerWidth - 16);
  const height = Math.min(HEIGHT, window.innerHeight - 16);
  const groups = groupByFile(references);
  const inReview = groups.filter((g) => g.inReview);
  const elsewhere = groups.filter((g) => !g.inReview);
  const truncated = entry.references.status === 'ready' && entry.references.value?.truncated === true;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Definition and uses"
      data-code-intel=""
      style={{ ...placement(nav.rect, width, height), width, height }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b pl-1 pr-1 text-xs">
        <button
          type="button"
          onClick={() => onStep(-1)}
          disabled={nav.index === 0}
          aria-label="Back"
          title={`Back (${IS_MAC ? '⌘[' : 'Ctrl+['})`}
          className="chrome-icon-btn size-6 shrink-0 text-chrome-fg-subtle disabled:opacity-40"
        >
          <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onStep(1)}
          disabled={nav.index === nav.entries.length - 1}
          aria-label="Forward"
          title={`Forward (${IS_MAC ? '⌘]' : 'Ctrl+]'})`}
          className="chrome-icon-btn size-6 shrink-0 text-chrome-fg-subtle disabled:opacity-40"
        >
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="ml-1 min-w-0 truncate font-mono text-chrome-fg">{entry.name}</span>
        {entry.references.status === 'ready' && entry.references.value !== null && (
          <span className="shrink-0 text-micro text-chrome-fg-subtle">
            {references.length === 1 ? '1 use' : `${references.length}${truncated ? '+' : ''} uses`}
          </span>
        )}
        <span className="ml-auto" />
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-y-auto border-r py-1 text-xs">
          <Section title="Definition">
            {entry.definition.status === 'loading' ? (
              <Note>Finding the definition…</Note>
            ) : definition === null ? (
              <Note>{loadError(entry.definition) ?? 'No definition found'}</Note>
            ) : (
              <FileRow
                path={definition.path}
                line={definition.line}
                active={selected?.ref === definition.ref && selected.line === definition.line}
                onClick={() => onSelect({ ref: definition.ref, line: definition.line })}
              />
            )}
          </Section>
          {entry.references.status === 'loading' ? (
            <Section title="Uses">
              <Note>Finding uses…</Note>
            </Section>
          ) : references.length === 0 ? (
            <Section title="Uses">
              <Note>{loadError(entry.references) ?? 'No uses found'}</Note>
            </Section>
          ) : (
            <>
              {inReview.length > 0 && (
                <Section title={`Uses in this review · ${inReview.reduce((n, g) => n + g.uses.length, 0)}`}>
                  <Groups groups={inReview} selected={selected} onSelect={onSelect} />
                </Section>
              )}
              {elsewhere.length > 0 && (
                <Section title={`Uses elsewhere · ${elsewhere.reduce((n, g) => n + g.uses.length, 0)}`}>
                  <Groups groups={elsewhere} selected={selected} onSelect={onSelect} />
                </Section>
              )}
              {truncated && <Note>Only the first {references.length} are listed.</Note>}
            </>
          )}
        </div>
        <Preview
          reviewId={reviewId}
          selected={selected}
          definition={definition}
          preview={preview}
          onJump={onJump}
        />
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      title="Close (Esc)"
      className="chrome-icon-btn ml-auto size-6 shrink-0 text-chrome-fg-subtle"
    >
      <X size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pb-1">
      <div className="px-3 pb-0.5 pt-1.5 text-micro text-chrome-fg-subtle">{title}</div>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="px-3 py-0.5 text-chrome-fg-muted">{children}</div>;
}

function FileRow({
  path,
  line,
  active,
  onClick,
}: {
  path: string;
  line?: number;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { name, dir } = splitPath(path);
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onClick}
      title={path}
      className={`flex w-full min-w-0 items-baseline gap-1.5 px-3 py-0.5 text-left transition-colors hover:bg-chrome-bg-hover ${active ? 'bg-chrome-bg-hover text-chrome-fg' : 'text-chrome-fg'}`}
    >
      <span className="shrink-0 truncate">{name}</span>
      {line !== undefined && <span className="shrink-0 font-mono text-micro text-chrome-fg-subtle">:{line}</span>}
      <span className="min-w-0 truncate text-micro text-chrome-fg-subtle">{dir}</span>
    </button>
  );
}

function Groups({
  groups,
  selected,
  onSelect,
}: {
  groups: readonly FileGroup[];
  selected: NavEntry['selected'];
  onSelect: (selected: { ref: string; line: number }) => void;
}): React.JSX.Element {
  return (
    <>
      {groups.map((group) => (
        <div key={group.ref}>
          <FileRow
            path={group.path}
            active={false}
            onClick={() => {
              const first = group.uses[0];
              if (first !== undefined) onSelect({ ref: first.ref, line: first.line });
            }}
          />
          {group.uses.map((use) => (
            <UseRow
              key={`${use.line}:${use.character}`}
              use={use}
              active={selected?.ref === use.ref && selected.line === use.line}
              onClick={() => onSelect({ ref: use.ref, line: use.line })}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function UseRow({ use, active, onClick }: { use: LspReference; active: boolean; onClick: () => void }): React.JSX.Element {
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onClick}
      className={`flex w-full min-w-0 items-baseline gap-2 py-0.5 pl-5 pr-3 text-left font-mono text-micro transition-colors hover:bg-chrome-bg-hover ${active ? 'bg-chrome-bg-hover text-chrome-fg' : 'text-chrome-fg-muted'}`}
    >
      <span className="w-7 shrink-0 text-right text-chrome-fg-subtle">{use.line}</span>
      <span className="min-w-0 truncate">{use.preview}</span>
    </button>
  );
}

function Preview({
  reviewId,
  selected,
  definition,
  preview,
  onJump,
}: {
  reviewId: string;
  selected: NavEntry['selected'];
  definition: LspDefinition | null;
  preview: PreviewHandlers;
  onJump: (path: string, line: number) => void;
}): React.JSX.Element {
  const { chromeMode } = useTheme();
  const load = usePreviewFile(reviewId, selected?.ref ?? null, definition);
  const file = load?.status === 'ready' ? load.value : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLElement | null>(null);
  const rendered = useRef<string | null>(null);
  /** The line still to bring into view, and the file it is in. */
  const pending = useRef<{ ref: string; line: number } | null>(null);

  const contents = useMemo(
    () => (file === null ? null : { name: file.path, contents: file.text, cacheKey: `peek:${file.ref}:${file.text.length}` }),
    [file],
  );

  // Brings `pending` a third of the way down, once its file's rows are rendered.
  const reveal = useCallback(() => {
    const want = pending.current;
    const body = bodyRef.current;
    if (want === null || body === null || rendered.current !== want.ref) return;
    const row = host.current?.shadowRoot?.querySelector(`[data-line="${want.line}"]`);
    if (row == null) return;
    pending.current = null;
    body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
  }, []);

  useEffect(() => {
    pending.current = selected;
    reveal();
  }, [selected, file, reveal]);

  const options = useMemo(
    () => ({
      disableFileHeader: true,
      themeType: chromeMode,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      overflow: 'scroll' as const,
      unsafeCSS: `:host { --diffs-bg: var(--chrome-bg-raised); }${CODE_INTEL_CSS}`,
      onPostRender: (node: HTMLElement) => {
        host.current = node;
        rendered.current = file?.ref ?? null;
        reveal();
      },
      onTokenEnter: (props: TokenEventBase, event: PointerEvent) => {
        if (file !== null) preview.onTokenEnter(props, event, file);
      },
      onTokenLeave: (props: TokenEventBase) => preview.onTokenLeave(props),
      onTokenClick: (props: TokenEventBase, event: MouseEvent) => {
        if (file !== null) preview.onTokenClick(props, event, file);
      },
    }),
    [chromeMode, file, preview, reveal],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b pl-3 pr-1 text-xs">
        {file !== null && selected !== null ? (
          <>
            <span className="min-w-0 truncate font-mono text-chrome-fg" title={file.path}>
              {file.path}
              <span className="text-chrome-fg-subtle">:{selected.line}</span>
            </span>
            {file.external && <span className="shrink-0 text-micro text-chrome-fg-subtle">outside this repo</span>}
            {file.truncated && <span className="shrink-0 text-micro text-chrome-fg-subtle">cut short, very large file</span>}
            {file.inReview && (
              <button
                type="button"
                onClick={() => onJump(file.ref, selected.line)}
                className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
              >
                Go to it in this review
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
              </button>
            )}
          </>
        ) : (
          <span className="text-chrome-fg-muted">
            {load === null
              ? 'Nothing to show'
              : load.status === 'loading'
                ? 'Opening…'
                : load.status === 'error'
                  ? `Couldn't open it: ${load.message}`
                  : 'This file is gone'}
          </span>
        )}
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {contents !== null && selected !== null && (
          <CodeFile
            file={contents}
            selectedLines={{ start: selected.line, end: selected.line }}
            options={options}
            style={
              {
                '--diffs-line-height': '20px',
                '--diffs-font-family': 'var(--chrome-font-mono)',
                '--diffs-font-size': '12px',
              } as React.CSSProperties
            }
          />
        )}
      </div>
    </div>
  );
}
