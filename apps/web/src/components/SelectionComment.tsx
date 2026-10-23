/**
 * Commenting on a text selection. `@pierre/diffs` only selects whole lines
 * (`enableLineSelection`), so this reads the browser's own text selection
 * inside a file's shadow root: a moment after the pointer is released on a
 * selection, a comment button appears just past the end of the selected text
 * (not at the cursor, which can be far off to the side of a drag). Clicking it opens
 * the ordinary draft composer under the last selected line, prefilled with
 * the selected text as a fenced block, which the reader can edit or delete.
 */
import { MessageSquarePlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DraftThread } from '../state/ReviewContext.tsx';

/** How long a released selection sits before the button shows. */
const SHOW_DELAY_MS = 350;
/**
 * The button's side: no taller than a diff line, so it sits within the
 * selection's last row. Hover cards open above or below their token's row,
 * and they are held off while the button shows anyway (see `useCodeIntel`).
 */
const BUTTON_SIZE = 22;

type Offer = { left: number; top: number; draft: DraftThread };

type Side = 'deletions' | 'additions';

/** Mirrors upstream's `getAnnotationSide` (managers/InteractionManager.js). */
function sideOf(row: Element): Side {
  switch (row.getAttribute('data-line-type')) {
    case 'change-deletion':
      return 'deletions';
    case 'change-addition':
      return 'additions';
    default:
      return row.closest('[data-deletions]') !== null ? 'deletions' : 'additions';
  }
}

/**
 * The selection inside `root`, as a live Range. The document's own selection
 * is retargeted to the shadow host in Chromium, so this asks for the composed
 * range where supported and falls back to Chromium's `ShadowRoot.getSelection`.
 */
function selectedRange(root: ShadowRoot): Range | null {
  const selection = document.getSelection();
  if (selection === null) return null;
  let bounds: AbstractRange | undefined;
  const composed = (selection as { getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[] })
    .getComposedRanges;
  if (composed !== undefined) bounds = composed.call(selection, { shadowRoots: [root] })[0];
  if (bounds === undefined || bounds.collapsed) {
    const own = (root as { getSelection?: () => Selection | null }).getSelection?.();
    if (own != null && own.rangeCount > 0) bounds = own.getRangeAt(0);
  }
  if (bounds === undefined || bounds.collapsed) return null;
  if (bounds.startContainer.getRootNode() !== root || bounds.endContainer.getRootNode() !== root) return null;
  const range = document.createRange();
  range.setStart(bounds.startContainer, bounds.startOffset);
  range.setEnd(bounds.endContainer, bounds.endOffset);
  return range;
}

/** Wraps `text` in a fence longer than any backtick run inside it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}\n\n`;
}

/**
 * The draft for a selection: anchored under the last selected line, on that
 * line's side, spanning the selected lines of that side. Null when the
 * selection holds no code (e.g. it lies in a header or a comment thread).
 */
function draftFor(path: string, root: ShadowRoot, range: Range): { draft: DraftThread; end: DOMRect } | null {
  const rows: { row: Element; text: string; part: Range }[] = [];
  for (const row of root.querySelectorAll('[data-content] > [data-line]')) {
    if (!range.intersectsNode(row)) continue;
    const part = document.createRange();
    part.selectNodeContents(row);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    rows.push({ row, text: part.toString().replace(/\n$/, ''), part });
  }
  // A drag to the start of the next line, or a triple-click, touches a row
  // without selecting any of it.
  while (rows.length > 0 && rows[0]!.text === '') rows.shift();
  while (rows.length > 0 && rows[rows.length - 1]!.text === '') rows.pop();
  const last = rows[rows.length - 1];
  if (last === undefined) return null;

  const side = sideOf(last.row);
  const lines = rows
    .filter(({ row }) => sideOf(row) === side)
    .map(({ row }) => Number(row.getAttribute('data-line')))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (lines.length === 0) return null;
  return {
    draft: {
      path,
      side: side === 'deletions' ? 'old' : 'new',
      startLine: Math.min(...lines),
      endLine: Math.max(...lines),
      body: fenced(rows.map((r) => r.text).join('\n')),
    },
    end: last.part.getBoundingClientRect(),
  };
}

/** Just past the selected text on its last row, kept inside the file card. */
function offerAt(end: DOMRect, card: DOMRect): Pick<Offer, 'left' | 'top'> {
  const margin = 8;
  const right = Math.min(card.right, window.innerWidth) - BUTTON_SIZE - margin;
  return { left: Math.max(card.left + margin, Math.min(end.right + 6, right)), top: end.top + (end.height - BUTTON_SIZE) / 2 };
}

export function useSelectionComment(startDraftThread: (draft: DraftThread) => void): {
  /** Whether the button is up; code-intel hover cards hold off meanwhile. */
  active: boolean;
  /** Records each file's host element; chain it into CodeView's `onPostRender`. */
  trackItem: (node: HTMLElement, phase: string, path: string) => void;
  overlay: React.ReactNode;
} {
  const hosts = useRef(new Map<HTMLElement, string>());
  const [offer, setOffer] = useState<Offer | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const trackItem = useCallback((node: HTMLElement, phase: string, path: string) => {
    if (phase === 'unmount') hosts.current.delete(node);
    else hosts.current.set(node, path);
  }, []);

  useEffect(() => {
    let timer = 0;
    const hide = () => {
      window.clearTimeout(timer);
      setOffer(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current !== null && event.composedPath().includes(buttonRef.current)) return;
      hide();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      const host = event.composedPath().find((el): el is HTMLElement => el instanceof HTMLElement && hosts.current.has(el));
      if (host?.shadowRoot == null) return;
      const path = hosts.current.get(host)!;
      const root = host.shadowRoot;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const range = selectedRange(root);
        const found = range === null ? null : draftFor(path, root, range);
        setOffer(found === null ? null : { ...offerAt(found.end, host.getBoundingClientRect()), draft: found.draft });
      }, SHOW_DELAY_MS);
    };
    const onSelectionChange = () => {
      if (document.getSelection()?.isCollapsed === true) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown, true);
    // Capture: scroll doesn't bubble, and the diff scrolls in its own container.
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  const overlay =
    offer === null
      ? null
      : createPortal(
          <button
            ref={buttonRef}
            type="button"
            title="Comment on the selection"
            aria-label="Comment on the selection"
            // Pressing a button can collapse the selection, which would hide
            // this button before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOffer(null);
              document.getSelection()?.removeAllRanges();
              startDraftThread(offer.draft);
            }}
            style={{ left: offer.left, top: offer.top, width: BUTTON_SIZE, height: BUTTON_SIZE }}
            // Not `chrome-icon-btn`: its hover swaps in a translucent
            // background, and this floats over code.
            className="fixed z-[60] inline-flex items-center justify-center rounded-md bg-chrome-bg-raised text-chrome-fg-muted shadow-chrome ring-1 ring-chrome-fg/10 transition-colors hover:text-chrome-fg hover:ring-chrome-fg/25"
          >
            <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden />
          </button>,
          document.body,
        );

  return { active: offer !== null, trackItem, overlay };
}
