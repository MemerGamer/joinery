/**
 * Language intelligence in the diff, from the language server the server runs
 * against the review's checkout (see apps/server/src/lsp):
 *
 * - hover a name → a small popover with its signature and docblock;
 * - ⌘-click it (Ctrl-click elsewhere), or "Definition and uses" in that
 *   popover → the peek window (PeekNavigator.tsx): the definition, its
 *   implementations and every use on the left, the chosen file on the right, where hover and ⌘-click
 *   work again and step through a history of their own;
 * - double-click it → every place it appears in that file is marked, from
 *   the server's `documentHighlight` (one file, so cheap); a click elsewhere
 *   or Esc clears them.
 *
 * Tokens come from `@pierre/diffs`' own token events (`onTokenEnter` and
 * friends, enabled by `useTokenTransformer` in lib/workerPool.tsx), which
 * already carry the line number, side, and character span — no hit-testing.
 * Only the head side has positions the server knows: additions and context
 * lines, plus, in split view, a context line's left copy (mapped to its
 * right-hand twin). A deleted line has no head position and gets nothing.
 *
 * Hover cards can be turned off (Settings → Language servers); the peek
 * window can't, it only opens on purpose.
 *
 * Nothing here can hold up the diff: requests start after a hover rests for
 * the delay set in Settings (300 ms by default), the previous one is aborted when the pointer moves on (the
 * server forwards that as `$/cancelRequest`), and answers are cached per
 * (file blob, line, token), which is immutable, for the life of the page.
 */
import type { DiffTokenEventBaseProps, PostRenderPhase, TokenEventBase } from '@pierre/diffs';
import type { LspDefinition, LspFile, LspHighlight, LspHover, LspLanguage, LspReferences } from '@joinery/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../lib/apiClient.ts';
import { cached, getHoverDelay, getHoverEnabled, getImplementationJump, IS_MAC, PEEK_KEY, placement } from '../lib/codeIntel.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Markdown } from './Markdown.tsx';
import { otherImplementations, PeekNavigator, type Load, type Nav, type NavEntry } from './PeekNavigator.tsx';

/** Grace to move the pointer from the token onto the popover. */
const CLOSE_DELAY_MS = 150;
/** How long the line a jump lands on stays highlighted. */
const JUMP_HIGHLIGHT_MS = 1_600;
const SUPPORTED = /\.(?:[cm]?[jt]sx?|php)$/i;
/** A token worth asking about has a letter, `_` or `$` in it — not `(`, `=>`, `42`. */
const NAME_LIKE = /[\p{L}_$]/u;

const hoverCache = new Map<string, Promise<LspHover | null>>();
// Whole answers, `off` included; an answer saying the server is off isn't kept, so turning it on takes effect.
const definitionCache = new Map<string, Promise<{ definition: LspDefinition | null; off: LspLanguage | null }>>();
const referencesCache = new Map<string, Promise<{ references: LspReferences | null; off: LspLanguage | null }>>();
const implementationsCache = new Map<string, Promise<{ implementations: LspReferences | null; off: LspLanguage | null }>>();
const highlightsCache = new Map<string, Promise<LspHighlight[]>>();

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

function rootOf(node: HTMLElement): ParentNode {
  return node.shadowRoot ?? node;
}

function unmarkOccurrences(node: HTMLElement): void {
  for (const el of rootOf(node).querySelectorAll('[data-lsp-occurrence]')) el.removeAttribute('data-lsp-occurrence');
}

/**
 * Marks the tokens covering `ranges` in a rendered file: head-side rows only
 * (not deleted lines, nor the base column in split view), and every token
 * overlapping a range, since the highlighter's tokens needn't match it exactly.
 */
function markOccurrences(node: HTMLElement, ranges: readonly LspHighlight[]): void {
  const root = rootOf(node);
  for (const range of ranges) {
    for (const row of root.querySelectorAll(`[data-line="${range.line}"]:not([data-line-type="change-deletion"])`)) {
      if (row.closest('[data-deletions]') !== null) continue;
      for (const token of row.querySelectorAll('[data-char]')) {
        const text = token.textContent ?? '';
        const start = Number(token.getAttribute('data-char')) + text.length - text.trimStart().length;
        const end = start + text.trim().length;
        if (start < range.end && end > range.start) token.setAttribute('data-lsp-occurrence', '');
      }
    }
  }
}

/**
 * A token to ask about. `path` is what the server resolves: a diff path, or a
 * file's `ref` when the token is in the peek window's preview (`inPreview`).
 * `version` names the text it was read from (a blob, or the preview's text).
 */
type Target = {
  path: string;
  version: string;
  pos: HeadPosition;
  tokenStart: number;
  element: HTMLElement;
  name: string;
  inPreview: boolean;
};

type HoverCard = { target: Target; rect: DOMRect; hover: LspHover };

const LOADING = { status: 'loading' } as const;

function failed(err: unknown): Load<never> {
  return { status: 'error', message: err instanceof Error ? err.message : String(err) };
}

/**
 * What an entry opens on, once enough is in to tell (null until then): the
 * only implementation when there's one and Settings says to jump to it, else
 * the definition, else the first implementation or use.
 */
function autoSelected(e: NavEntry): NavEntry['selected'] {
  const jump = getImplementationJump();
  if (jump && e.implementations.status === 'loading') return null;
  const implementations = otherImplementations(e);
  const [only] = implementations;
  if (jump && implementations.length === 1 && only !== undefined) return { ref: only.ref, line: only.line };
  if (e.definition.status === 'loading') return null;
  if (e.definition.status === 'ready' && e.definition.value !== null) {
    return { ref: e.definition.value.ref, line: e.definition.value.line };
  }
  if (e.implementations.status === 'loading') return null;
  const first = implementations[0] ?? (e.references.status === 'ready' ? e.references.value?.references[0] : undefined);
  if (first !== undefined) return { ref: first.ref, line: first.line };
  return null;
}

export function useCodeIntel({ hoverSuppressed = false }: { hoverSuppressed?: boolean } = {}): {
  onTokenEnter: (props: TokenProps, event: PointerEvent, context: TokenContext) => void;
  onTokenLeave: (props: TokenProps, event: PointerEvent, context: TokenContext) => void;
  onTokenClick: (props: TokenProps, event: MouseEvent, context: TokenContext) => void;
  onPostRender: (node: HTMLElement, instance: unknown, phase: PostRenderPhase, context: TokenContext) => void;
  overlay: React.ReactNode;
} {
  const { review, fileList, items, codeViewRef } = useReview();
  const reviewId = review?.id ?? '';
  const blobs = useMemo(() => new Map(fileList.map((f) => [f.path, f.newBlob])), [fileList]);

  const [card, setCard] = useState<HoverCard | null>(null);
  const [nav, setNav] = useState<Nav | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const current = useRef<Target | null>(null);
  const modifierDown = useRef(false);
  const entryIds = useRef(0);
  /** Each file's rendered node in the diff, to mark occurrences in. */
  const containers = useRef(new Map<string, HTMLElement>());
  /** The double-clicked symbol's places in its file, kept marked across re-renders. */
  const occurrences = useRef<{ path: string; ranges: LspHighlight[] } | null>(null);
  const occurrencesRequest = useRef<AbortController | null>(null);

  const keyOf = useCallback(
    (t: Target) => `${reviewId}:${t.path}:${t.version}:${t.pos.line}:${t.tokenStart}`,
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

  // Held off while the selection's comment button is up (SelectionComment.tsx),
  // so a card can't open over it; one already open closes.
  const suppressed = useRef(hoverSuppressed);
  suppressed.current = hoverSuppressed;
  useEffect(() => {
    if (!hoverSuppressed) return;
    cancelHover();
    setCard(null);
  }, [hoverSuppressed, cancelHover]);

  const keepOpen = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const diffTarget = useCallback(
    (props: TokenProps, context: TokenContext): Target | null => {
      const path = context.item.id;
      const blob = blobs.get(path);
      if (reviewId === '' || blob === undefined || !SUPPORTED.test(path) || !NAME_LIKE.test(props.tokenText)) return null;
      const pos = headPosition(props);
      if (pos === null) return null;
      const name = props.tokenText.trim();
      return { path, version: blob, pos, tokenStart: props.lineCharStart, element: props.tokenElement, name, inPreview: false };
    },
    [blobs, reviewId],
  );

  const previewTarget = useCallback(
    (props: TokenProps, file: LspFile): Target | null => {
      if (reviewId === '' || !SUPPORTED.test(file.path) || !NAME_LIKE.test(props.tokenText)) return null;
      const pos = headPosition(props);
      if (pos === null) return null;
      return {
        path: file.ref,
        version: `${file.text.length}:${file.truncated}`,
        pos,
        tokenStart: props.lineCharStart,
        element: props.tokenElement,
        name: props.tokenText.trim(),
        inPreview: true,
      };
    },
    [reviewId],
  );

  const enter = useCallback(
    (target: Target | null, event: PointerEvent) => {
      cancelHover();
      current.current = target;
      if (target === null) return;
      setLink(target.element, event.metaKey || event.ctrlKey || modifierDown.current);
      // Hover cards turned off in Settings; ⌘-click still peeks.
      if (!getHoverEnabled() || suppressed.current) return;
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
            if (current.current !== target || suppressed.current) return;
            keepOpen();
            if (hover === null) setCard(null);
            else setCard({ target, rect: target.element.getBoundingClientRect(), hover });
          })
          .catch(() => undefined);
      }, getHoverDelay());
    },
    [cancelHover, keepOpen, keyOf, reviewId],
  );

  const leave = useCallback(
    (props: TokenProps) => {
      setLink(props.tokenElement, false);
      if (current.current?.element === props.tokenElement) current.current = null;
      cancelHover();
      scheduleClose();
    },
    [cancelHover, scheduleClose],
  );

  /**
   * Definition and uses of `target`, in the peek window: a new window from the
   * diff, or the next step of the open one's history from inside its preview.
   */
  const openPeek = useCallback(
    (target: Target) => {
      cancelHover();
      setCard(null);
      entryIds.current += 1;
      const id = entryIds.current;
      const entry: NavEntry = {
        id,
        name: target.name,
        definition: LOADING,
        implementations: LOADING,
        references: LOADING,
        selected: null,
        off: null,
      };
      setNav((n) =>
        target.inPreview && n !== null
          ? { ...n, entries: [...n.entries.slice(0, n.index + 1), entry], index: n.index + 1 }
          : { rect: target.element.getBoundingClientRect(), origin: target.element, entries: [entry], index: 0 },
      );
      // Each answer lands in the entry; what's shown is picked once enough is in, and then kept.
      const update = (patch: (e: NavEntry) => NavEntry) =>
        setNav((n) => {
          if (n === null) return n;
          return {
            ...n,
            entries: n.entries.map((e) => {
              if (e.id !== id) return e;
              const next = patch(e);
              return { ...next, selected: next.selected ?? autoSelected(next) };
            }),
          };
        });
      const key = keyOf(target);
      const query = { path: target.path, line: target.pos.line, character: target.pos.character };
      cached(definitionCache, key, () => callApi('getDefinition', { params: [reviewId], query })).then(
        ({ definition, off }) => {
          if (off !== null) definitionCache.delete(key);
          update((e) => ({ ...e, off: e.off ?? off, definition: { status: 'ready', value: definition } }));
        },
        (err: unknown) => update((e) => ({ ...e, definition: failed(err) })),
      );
      cached(implementationsCache, key, () => callApi('getImplementations', { params: [reviewId], query })).then(
        ({ implementations, off }) => {
          if (off !== null) implementationsCache.delete(key);
          update((e) => ({ ...e, off: e.off ?? off, implementations: { status: 'ready', value: implementations } }));
        },
        (err: unknown) => update((e) => ({ ...e, implementations: failed(err) })),
      );
      cached(referencesCache, key, () => callApi('getReferences', { params: [reviewId], query })).then(
        ({ references, off }) => {
          if (off !== null) referencesCache.delete(key);
          update((e) => ({ ...e, off: e.off ?? off, references: { status: 'ready', value: references } }));
        },
        (err: unknown) => update((e) => ({ ...e, references: failed(err) })),
      );
    },
    [cancelHover, keyOf, reviewId],
  );

  const click = useCallback(
    (target: Target | null, event: MouseEvent) => {
      if (!(IS_MAC ? event.metaKey : event.ctrlKey)) return;
      // A drag that ends on a token is a text selection, not a click on it.
      if (window.getSelection()?.isCollapsed === false) return;
      if (target === null) return;
      event.preventDefault();
      openPeek(target);
    },
    [openPeek],
  );

  const onTokenEnter = useCallback(
    (props: TokenProps, event: PointerEvent, context: TokenContext) => enter(diffTarget(props, context), event),
    [diffTarget, enter],
  );
  const clearOccurrences = useCallback(() => {
    occurrencesRequest.current?.abort();
    occurrencesRequest.current = null;
    const shown = occurrences.current;
    if (shown === null) return;
    occurrences.current = null;
    const node = containers.current.get(shown.path);
    if (node !== undefined) unmarkOccurrences(node);
  }, []);

  const showOccurrences = useCallback(
    (target: Target | null) => {
      clearOccurrences();
      if (target === null) return;
      const controller = new AbortController();
      occurrencesRequest.current = controller;
      const key = keyOf(target);
      cached(highlightsCache, key, () =>
        callApi('getHighlights', {
          params: [reviewId],
          query: { path: target.path, line: target.pos.line, character: target.pos.character },
          signal: controller.signal,
        }).then((r) => r.highlights),
      )
        .then((ranges) => {
          // Nothing found may be a server switched off or still starting: asked again next time.
          if (ranges.length === 0) highlightsCache.delete(key);
          if (occurrencesRequest.current !== controller) return;
          occurrencesRequest.current = null;
          if (ranges.length === 0) return;
          occurrences.current = { path: target.path, ranges };
          const node = containers.current.get(target.path);
          if (node !== undefined) markOccurrences(node, ranges);
        })
        .catch(() => undefined);
    },
    [clearOccurrences, keyOf, reviewId],
  );

  const onTokenClick = useCallback(
    (props: TokenProps, event: MouseEvent, context: TokenContext) => {
      const target = diffTarget(props, context);
      if (event.detail === 2 && !(IS_MAC ? event.metaKey : event.ctrlKey)) showOccurrences(target);
      else click(target, event);
    },
    [click, diffTarget, showOccurrences],
  );

  // Rows are rebuilt as the diff scrolls and re-renders: marks follow them.
  const onPostRender = useCallback((node: HTMLElement, _instance: unknown, phase: PostRenderPhase, context: TokenContext) => {
    const path = context.item.id;
    if (phase === 'unmount') {
      if (containers.current.get(path) === node) containers.current.delete(path);
      unmarkOccurrences(node);
      return;
    }
    containers.current.set(path, node);
    const shown = occurrences.current;
    if (shown === null) return;
    unmarkOccurrences(node);
    if (shown.path === path) markOccurrences(node, shown.ranges);
  }, []);

  // A single click anywhere (the first of a new double-click included), or Esc, clears the marks.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.detail < 2) clearOccurrences();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearOccurrences();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [clearOccurrences]);
  const preview = useMemo(
    () => ({
      onTokenEnter: (props: TokenProps, event: PointerEvent, file: LspFile) => enter(previewTarget(props, file), event),
      onTokenLeave: leave,
      onTokenClick: (props: TokenProps, event: MouseEvent, file: LspFile) => click(previewTarget(props, file), event),
    }),
    [click, enter, leave, previewTarget],
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

  const origin = nav?.origin;
  useEffect(() => {
    if (origin === undefined) return;
    origin.setAttribute('data-lsp-origin', '');
    return () => origin.removeAttribute('data-lsp-origin');
  }, [origin]);

  const jump = useCallback(
    (path: string, line: number) => {
      setNav(null);
      setCard(null);
      const item = items.find((i) => i.id === path);
      if (item === undefined) return;
      // Only a line inside a shown hunk can be scrolled to; else the file's top.
      const shown = item.collapsed !== true && item.fileDiff.hunks.some(
        (h) => line >= h.additionStart && line < h.additionStart + h.additionCount,
      );
      const view = codeViewRef.current;
      if (view === null) return;
      view.scrollTo(
        shown
          ? { type: 'line', id: path, lineNumber: line, side: 'additions', align: 'center' }
          : { type: 'item', id: path, align: 'start' },
      );
      // Mark the landing line for a moment with the line selection, unless the
      // reader has one of their own (a comment being drafted) to keep.
      if (!shown || view.getSelectedLines() !== null) return;
      const mark = { id: path, range: { start: line, end: line, side: 'additions' as const } };
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

  const select = useCallback(
    (selected: NonNullable<NavEntry['selected']>) =>
      setNav((n) =>
        n === null ? n : { ...n, entries: n.entries.map((e, i) => (i === n.index ? { ...e, selected } : e)) },
      ),
    [],
  );
  const step = useCallback(
    (delta: 1 | -1) =>
      setNav((n) => (n === null ? n : { ...n, index: Math.max(0, Math.min(n.entries.length - 1, n.index + delta)) })),
    [],
  );
  const closeNav = useCallback(() => {
    setNav(null);
    setCard(null);
  }, []);

  const overlay = (
    <>
      {nav !== null &&
        createPortal(
          <PeekNavigator
            nav={nav}
            reviewId={reviewId}
            preview={preview}
            onSelect={select}
            onStep={step}
            onJump={jump}
            onClose={closeNav}
          />,
          document.body,
        )}
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
    </>
  );

  return { onTokenEnter, onTokenLeave: leave, onTokenClick, onPostRender, overlay };
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
      data-code-intel=""
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={{ ...placement(card.rect, width, 260), maxWidth: width }}
      // Above the peek window, whose preview has hover cards of its own.
      className="fixed z-[60] flex flex-col overflow-hidden rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10"
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
          Definition and uses
        </button>
        <span>{PEEK_KEY}-click</span>
        <span className="ml-auto font-mono">{card.hover.server}</span>
      </div>
    </div>
  );
}
