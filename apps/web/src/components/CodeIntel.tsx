/**
 * Language intelligence in the diff, from the language server the server runs
 * against the review's checkout (see apps/server/src/lsp):
 *
 * - hover a name → a small popover with its signature and docblock;
 * - ⌘-click it (Ctrl-click elsewhere), or "Peek definition" in that popover →
 *   a floating window with the definition's whole file, scrolled to it and
 *   highlighted like the diff, with a jump into the diff when the definition
 *   is in a changed file.
 *
 * Tokens come from `@pierre/diffs`' own token events (`onTokenEnter` and
 * friends, enabled by `useTokenTransformer` in lib/workerPool.tsx), which
 * already carry the line number, side, and character span — no hit-testing.
 * Only the head side has positions the server knows: additions and context
 * lines, plus, in split view, a context line's left copy (mapped to its
 * right-hand twin). A deleted line has no head position and gets nothing.
 *
 * Nothing here can hold up the diff: requests start after a hover rests for
 * `HOVER_DELAY_MS`, the previous one is aborted when the pointer moves on (the
 * server forwards that as `$/cancelRequest`), and answers are cached per
 * (file blob, line, token), which is immutable, for the life of the page.
 */
import { File as CodeFile } from '@pierre/diffs/react';
import type { DiffTokenEventBaseProps, TokenEventBase } from '@pierre/diffs';
import type { LspDefinition, LspHover } from '@joinery/core';
import { ArrowUpRight, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../lib/apiClient.ts';
import { PREFERRED_HIGHLIGHTER } from '../lib/workerPool.tsx';
import { useReview } from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';
import { Markdown } from './Markdown.tsx';

const HOVER_DELAY_MS = 300;
/** Grace to move the pointer from the token onto the popover. */
const CLOSE_DELAY_MS = 150;
const CACHE_LIMIT = 2_000;
/** How long the line a jump lands on stays highlighted. */
const JUMP_HIGHLIGHT_MS = 1_600;
const SUPPORTED = /\.(?:[cm]?[jt]sx?|php)$/i;
/** A token worth asking about has a letter, `_` or `$` in it — not `(`, `=>`, `42`. */
const NAME_LIKE = /[\p{L}_$]/u;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const PEEK_KEY = IS_MAC ? '⌘' : 'Ctrl';

/**
 * Injected into each file's shadow root alongside the card CSS: the token
 * under the pointer reads as a link while the peek modifier is held.
 */
export const CODE_INTEL_CSS = `
[data-char][data-lsp-link] {
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
`;

const hoverCache = new Map<string, Promise<LspHover | null>>();
const definitionCache = new Map<string, Promise<LspDefinition | null>>();

/** Shared by every waiter; a request that fails or is aborted is dropped so the next hover asks again. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const promise = load();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return promise;
}

type TokenProps = TokenEventBase & Partial<Pick<DiffTokenEventBaseProps, 'side'>>;
type TokenContext = { item: { id: string } };
type HeadPosition = { line: number; character: number };

/** Where a token sits on the head side, or null when it only exists in the base. */
function headPosition(props: TokenProps): HeadPosition | null {
  // Middle of the name, robust to a server strict about name boundaries. The
  // highlighter may fold surrounding whitespace into a token (`"const "`).
  const lead = props.tokenText.length - props.tokenText.trimStart().length;
  const name = props.tokenText.trim().length;
  const character = props.lineCharStart + lead + Math.floor((name - 1) / 2);
  if (props.side !== 'deletions') return { line: props.lineNumber, character };
  const row = props.tokenElement.closest('[data-line]');
  if (row?.getAttribute('data-line-type')?.startsWith('context') !== true) return null;
  // `data-line-index` is "<unified>,<split>"; the two columns share the split row.
  const splitIndex = row.getAttribute('data-line-index')?.split(',')[1];
  if (splitIndex === undefined) return null;
  const twin = row
    .closest('pre')
    ?.querySelector(`[data-additions] [data-line][data-line-index$=",${CSS.escape(splitIndex)}"]`);
  const line = Number(twin?.getAttribute('data-line'));
  return Number.isInteger(line) && line > 0 ? { line, character } : null;
}

type Target = { path: string; blob: string; pos: HeadPosition; tokenStart: number; element: HTMLElement };

type HoverCard = { target: Target; rect: DOMRect; hover: LspHover };

type Peek =
  | { rect: DOMRect; status: 'loading' }
  | { rect: DOMRect; status: 'none' }
  | { rect: DOMRect; status: 'error'; message: string }
  | { rect: DOMRect; status: 'ready'; definition: LspDefinition };

export function useCodeIntel(): {
  onTokenEnter: (props: TokenProps, event: PointerEvent, context: TokenContext) => void;
  onTokenLeave: (props: TokenProps, event: PointerEvent, context: TokenContext) => void;
  onTokenClick: (props: TokenProps, event: MouseEvent, context: TokenContext) => void;
  overlay: React.ReactNode;
} {
  const { review, fileList, items, codeViewRef } = useReview();
  const reviewId = review?.id ?? '';
  const blobs = useMemo(() => new Map(fileList.map((f) => [f.path, f.newBlob])), [fileList]);

  const [card, setCard] = useState<HoverCard | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const current = useRef<Target | null>(null);
  const modifierDown = useRef(false);

  const keyOf = useCallback(
    (t: Target) => `${reviewId}:${t.path}:${t.blob}:${t.pos.line}:${t.tokenStart}`,
    [reviewId],
  );

  const setLink = (element: HTMLElement | undefined, on: boolean) => {
    if (on) element?.setAttribute('data-lsp-link', '');
    else element?.removeAttribute('data-lsp-link');
  };

  const cancelHover = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    inflight.current?.abort();
    inflight.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setCard(null), CLOSE_DELAY_MS);
  }, []);

  const keepOpen = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const targetOf = useCallback(
    (props: TokenProps, context: TokenContext): Target | null => {
      const path = context.item.id;
      const blob = blobs.get(path);
      if (reviewId === '' || blob === undefined || !SUPPORTED.test(path) || !NAME_LIKE.test(props.tokenText)) return null;
      const pos = headPosition(props);
      if (pos === null) return null;
      return { path, blob, pos, tokenStart: props.lineCharStart, element: props.tokenElement };
    },
    [blobs, reviewId],
  );

  const onTokenEnter = useCallback(
    (props: TokenProps, event: PointerEvent, context: TokenContext) => {
      const target = targetOf(props, context);
      cancelHover();
      current.current = target;
      if (target === null) return;
      setLink(target.element, event.metaKey || event.ctrlKey || modifierDown.current);
      const key = keyOf(target);
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        const controller = new AbortController();
        inflight.current = controller;
        cached(hoverCache, key, () =>
          callApi('getHover', {
            params: [reviewId],
            query: { path: target.path, line: target.pos.line, character: target.pos.character },
            signal: controller.signal,
          }).then((r) => r.hover),
        )
          .then((hover) => {
            if (current.current !== target) return;
            keepOpen();
            if (hover === null) setCard(null);
            else setCard({ target, rect: target.element.getBoundingClientRect(), hover });
          })
          .catch(() => undefined);
      }, HOVER_DELAY_MS);
    },
    [cancelHover, keepOpen, keyOf, reviewId, targetOf],
  );

  const onTokenLeave = useCallback(
    (props: TokenProps) => {
      setLink(props.tokenElement, false);
      if (current.current?.element === props.tokenElement) current.current = null;
      cancelHover();
      scheduleClose();
    },
    [cancelHover, scheduleClose],
  );

  const openPeek = useCallback(
    (target: Target) => {
      cancelHover();
      setCard(null);
      const rect = target.element.getBoundingClientRect();
      setPeek({ rect, status: 'loading' });
      cached(definitionCache, keyOf(target), () =>
        callApi('getDefinition', {
          params: [reviewId],
          query: { path: target.path, line: target.pos.line, character: target.pos.character },
        }).then((r) => r.definition),
      )
        .then((definition) =>
          setPeek((p) => (p?.rect !== rect ? p : definition === null ? { rect, status: 'none' } : { rect, status: 'ready', definition })),
        )
        .catch((err: unknown) =>
          setPeek((p) => (p?.rect !== rect ? p : { rect, status: 'error', message: err instanceof Error ? err.message : String(err) })),
        );
    },
    [cancelHover, keyOf, reviewId],
  );

  const onTokenClick = useCallback(
    (props: TokenProps, event: MouseEvent, context: TokenContext) => {
      if (!(IS_MAC ? event.metaKey : event.ctrlKey)) return;
      // A drag that ends on a token is a text selection, not a click on it.
      if (window.getSelection()?.isCollapsed === false) return;
      const target = targetOf(props, context);
      if (target === null) return;
      event.preventDefault();
      openPeek(target);
    },
    [openPeek, targetOf],
  );

  // The held modifier underlines the token under the pointer, editor-style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const down = IS_MAC ? e.metaKey : e.ctrlKey;
      if (down === modifierDown.current) return;
      modifierDown.current = down;
      setLink(current.current?.element, down);
    };
    const onBlur = () => {
      modifierDown.current = false;
      setLink(current.current?.element, false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // A scroll moves the token out from under the hover card; the peek window
  // stays put (it is a window of its own) until dismissed.
  useEffect(() => {
    if (card === null) return;
    const onScroll = () => setCard(null);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [card]);

  useEffect(() => () => cancelHover(), [cancelHover]);

  const jump = useCallback(
    (definition: LspDefinition) => {
      setPeek(null);
      const item = items.find((i) => i.id === definition.path);
      if (item === undefined) return;
      // Only a line inside a shown hunk can be scrolled to; else the file's top.
      const shown = item.collapsed !== true && item.fileDiff.hunks.some(
        (h) => definition.line >= h.additionStart && definition.line < h.additionStart + h.additionCount,
      );
      const view = codeViewRef.current;
      if (view === null) return;
      view.scrollTo(
        shown
          ? { type: 'line', id: definition.path, lineNumber: definition.line, side: 'additions', align: 'center' }
          : { type: 'item', id: definition.path, align: 'start' },
      );
      // Mark the landing line for a moment with the line selection, unless the
      // reader has one of their own (a comment being drafted) to keep.
      if (!shown || view.getSelectedLines() !== null) return;
      const mark = {
        id: definition.path,
        range: { start: definition.line, end: definition.line, side: 'additions' as const },
      };
      view.setSelectedLines(mark);
      window.setTimeout(() => {
        const current = view.getSelectedLines();
        if (current?.id === mark.id && current.range.start === mark.range.start && current.range.end === mark.range.end) {
          view.clearSelectedLines();
        }
      }, JUMP_HIGHLIGHT_MS);
    },
    [codeViewRef, items],
  );

  const overlay = (
    <>
      {card !== null &&
        createPortal(
          <HoverPopover
            card={card}
            onPointerEnter={keepOpen}
            onPointerLeave={scheduleClose}
            onPeek={() => openPeek(card.target)}
          />,
          document.body,
        )}
      {peek !== null && createPortal(<PeekWindow peek={peek} onClose={() => setPeek(null)} onJump={jump} />, document.body)}
    </>
  );

  return { onTokenEnter, onTokenLeave, onTokenClick, overlay };
}

/** Below the anchor when it fits, otherwise above; always inside the viewport. */
function placement(rect: DOMRect, width: number, height: number): React.CSSProperties {
  const margin = 8;
  const left = Math.max(margin, Math.min(rect.left - 12, window.innerWidth - width - margin));
  const below = rect.bottom + 6;
  if (below + height <= window.innerHeight - margin || rect.top - 6 - height < margin) {
    return { left, top: below, maxHeight: Math.max(120, window.innerHeight - below - margin) };
  }
  return { left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(120, rect.top - 6 - margin) };
}

function HoverPopover({
  card,
  onPointerEnter,
  onPointerLeave,
  onPeek,
}: {
  card: HoverCard;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPeek: () => void;
}): React.JSX.Element {
  const width = Math.min(560, window.innerWidth - 16);
  return (
    <div
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ ...placement(card.rect, width, 260), maxWidth: width }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10"
    >
      <div className="code-intel-hover min-h-0 overflow-auto px-2.5 py-1.5">
        <Markdown>{card.hover.markdown}</Markdown>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-t px-2.5 text-micro text-chrome-fg-subtle">
        <button
          type="button"
          onClick={onPeek}
          className="-ml-1.5 rounded px-1.5 py-0.5 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
        >
          Peek definition
        </button>
        <span>{PEEK_KEY}-click</span>
        <span className="ml-auto font-mono">{card.hover.server}</span>
      </div>
    </div>
  );
}

/**
 * The definition's whole file, rendered by `@pierre/diffs`' `File` with the
 * diff's own highlighter, theme and font, opened at the definition's line and
 * marking it as selected.
 */
function PeekWindow({
  peek,
  onClose,
  onJump,
}: {
  peek: Peek;
  onClose: () => void;
  onJump: (definition: LspDefinition) => void;
}): React.JSX.Element {
  const { chromeMode } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const definition = peek.status === 'ready' ? peek.definition : null;
  const file = useMemo(
    () =>
      definition === null
        ? null
        : { name: definition.path, contents: definition.text, cacheKey: `peek:${definition.path}:${definition.text.length}` },
    [definition],
  );
  // A status line ("No definition found") only needs to fit its text.
  const width = Math.min(definition === null ? 360 : 820, window.innerWidth - 16);
  // The whole file is shown: open it at the definition, once, a third of the way down.
  const scrolledTo = useRef<LspDefinition | null>(null);
  const onPostRender = useCallback(
    (node: HTMLElement) => {
      const body = bodyRef.current;
      if (definition === null || body === null || scrolledTo.current === definition) return;
      const row = node.shadowRoot?.querySelector(`[data-line="${definition.line}"]`);
      if (row == null) return;
      scrolledTo.current = definition;
      body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3;
    },
    [definition],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Definition"
      style={
        definition === null
          ? { ...placement(peek.rect, width, 40), maxWidth: width }
          : { ...placement(peek.rect, width, 460), width, height: 460 }
      }
      className="fixed z-50 flex flex-col overflow-hidden rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b pl-3 pr-1 text-xs">
        {definition !== null ? (
          <>
            <span className="min-w-0 truncate font-mono text-chrome-fg" title={definition.path}>
              {definition.path}
              <span className="text-chrome-fg-subtle">:{definition.line}</span>
            </span>
            {definition.external && <span className="shrink-0 text-micro text-chrome-fg-subtle">outside this repo</span>}
            {definition.truncated && <span className="shrink-0 text-micro text-chrome-fg-subtle">cut short, very large file</span>}
            {definition.inReview && (
              <button
                type="button"
                onClick={() => onJump(definition)}
                className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
              >
                Go to it in this review
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden />
              </button>
            )}
          </>
        ) : (
          <span className="text-chrome-fg-muted">
            {peek.status === 'loading'
              ? 'Finding the definition…'
              : peek.status === 'none'
                ? 'No definition found'
                : `Couldn't look it up: ${peek.status === 'error' ? peek.message : ''}`}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          className={`chrome-icon-btn size-6 shrink-0 text-chrome-fg-subtle ${definition?.inReview === true ? '' : 'ml-auto'}`}
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {definition !== null && file !== null && (
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
          <CodeFile
            file={file}
            selectedLines={{ start: definition.line, end: definition.line }}
            options={{
              disableFileHeader: true,
              onPostRender,
              themeType: chromeMode,
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              overflow: 'scroll',
              unsafeCSS: ':host { --diffs-bg: var(--chrome-bg-raised); }',
            }}
            style={
              {
                '--diffs-line-height': '20px',
                '--diffs-font-family': 'var(--chrome-font-mono)',
                '--diffs-font-size': '12px',
              } as React.CSSProperties
            }
          />
        </div>
      )}
    </div>
  );
}
