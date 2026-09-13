/**
 * The centre pane: one `CodeView` for the whole review (SPEC §6) — never one
 * `FileDiff` per file. Items are the file list, in reading-order-adjacent
 * sequence. `renderCodeViewHeader` shows the current step; `lineAnnotations`
 * + `renderAnnotation` render inline comment threads; `enableGutterUtility`
 * + `onGutterUtilityClick` drive the hover `+` for starting a new thread.
 */
import { CodeView } from '@pierre/diffs/react';
import type { CodeViewReactOptions } from '@pierre/diffs/react';
import type {
  DiffLineAnnotation,
  LineAnnotation,
  SelectedLineRange,
  CodeViewItem,
} from '@pierre/diffs';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { makeLoadDiffFiles } from '../lib/diffLoader.ts';
import {
  DRAFT_THREAD_ID,
  useReview,
  type ThreadAnnotationMeta,
} from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';
import { CommentComposer } from './CommentComposer.tsx';
import { ThreadArticle } from './ThreadArticle.tsx';
import { StepHeaderCard } from './StepHeaderCard.tsx';

/**
 * Diff density, in one place. These are *both* the `@pierre/diffs` CSS custom
 * properties we override and the `itemMetrics` we hand `CodeView` — they must
 * be the same numbers, which is why they are not written down twice.
 *
 * `CodeView` virtualizes the file list and computes every item's height
 * analytically from `itemMetrics`; `reconcileHeights()` only re-measures the
 * DOM for items that carry line annotations (see `VirtualizedFileDiff.js`,
 * the `overflow === 'scroll' && lineAnnotations.length === 0` early return),
 * so for an ordinary file these numbers are never corrected by measurement.
 * Overriding the density CSS without matching `itemMetrics` therefore
 * mis-sizes the whole scroll range — upstream says as much on
 * `VirtualFileMetrics.spacing` ("You should not change this from the default
 * if you aren't applying custom CSS"). The error is per-line and per-file, so
 * it accumulates downward and strands the *last* file: the scroll container
 * stops short of content that is laid out but unreachable.
 */
const DIFF_LINE_HEIGHT = 22;
/** Mirrors `--chrome-space-3` (src/styles/index.css); `--diffs-gap-block`. */
const DIFF_GAP_BLOCK = 12;
/**
 * Upstream's own header sizing is `min-height: calc(1lh + (gap * 3))` (see
 * `[data-diffs-header="default"]` in `@pierre/diffs/dist/style.js`), and its
 * default metric is exactly `20 + 8 * 3 = 44`. Deriving it the same way keeps
 * the two in step if the density above is ever retuned.
 */
const DIFF_HEADER_HEIGHT = DIFF_LINE_HEIGHT + DIFF_GAP_BLOCK * 3;

export function ReviewCodeView(): React.JSX.Element {
  const {
    review,
    reviewState,
    fileList,
    isViewed,
    toggleViewed,
    items,
    diffStyle,
    threads,
    readingOrder,
    selectedPath,
    startDraftThread,
    cancelDraftThread,
    submitDraftThread,
    reloadThreads,
    codeViewRef,
    toggleFileCollapsed,
  } = useReview();
  const { chromeMode } = useTheme();

  const loadDiffFiles = useMemo(
    () => makeLoadDiffFiles(review?.id ?? '', reviewState?.currentRevision),
    [review?.id, reviewState?.currentRevision],
  );

  const options = useMemo<CodeViewReactOptions<ThreadAnnotationMeta, undefined>>(
    () => ({
      diffStyle,
      // `CodeView` renders into its own shadow root and sets `:host {
      // color-scheme }` from `themeType`, which defaults to 'system' — i.e.
      // it follows the OS preference, NOT this app's chrome toggle. Without
      // this, flipping the app to light on a dark-mode machine leaves the
      // diff's own chrome (gutters, scrollbars, form controls) dark.
      themeType: chromeMode,
      hunkSeparators: 'line-info',
      // Must agree with the CSS custom properties set on the host element
      // below — see the DIFF_* constants above for why.
      itemMetrics: {
        lineHeight: DIFF_LINE_HEIGHT,
        spacing: DIFF_GAP_BLOCK,
        diffHeaderHeight: DIFF_HEADER_HEIGHT,
      },
      // Logs an error whenever an item's reconciled height disagrees with its
      // real DOM height, i.e. exactly the drift above. Upstream gates this to
      // its own dev build too, since it measures on every reconcile.
      __devOnlyValidateItemHeights: import.meta.env.DEV,
      enableGutterUtility: true,
      stickyHeaders: true,
      disableVirtualizationBuffers: false,
      layout: { paddingTop: 16, paddingBottom: 80, gap: 16 },
      loadDiffFiles,
      onGutterUtilityClick(range: SelectedLineRange, context) {
        startDraftThread({
          path: context.item.id,
          side: (range.side ?? 'additions') === 'deletions' ? 'old' : 'new',
          startLine: range.start,
          endLine: range.end,
        });
      },
    }),
    [chromeMode, diffStyle, loadDiffFiles, startDraftThread],
  );

  const byPath = useMemo(() => new Map(fileList.map((f) => [f.path, f])), [fileList]);

  const currentStep = useMemo(() => {
    if (readingOrder === null) return null;
    if (selectedPath !== null) {
      const step = readingOrder.steps.find((s) => s.files.some((f) => f.path === selectedPath));
      if (step !== undefined) return step;
    }
    return readingOrder.steps[0] ?? null;
  }, [readingOrder, selectedPath]);

  if (review === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-chrome-fg-muted">
        Loading review…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-chrome-fg-muted">
        No changed files in this revision.
      </div>
    );
  }

  return (
    <CodeView<ThreadAnnotationMeta, undefined>
      ref={codeViewRef}
      items={items}
      options={options}
      // `--diffs-gap-block`/`--diffs-line-height` are `@pierre/diffs`' own
      // density knobs (see `dist/style.js`: `padding-block: var(--diffs-gap-block,
      // var(--diffs-gap-fallback))` at 8px, `line-height: var(--diffs-line-height, 20px)`)
      // — custom properties inherit through the shadow root the same way
      // `--trees-density-override` does for `@pierre/trees` (FileTreePane.tsx),
      // so nudging them here loosens hunk/line spacing to match the rest of
      // the chrome's density pass without touching internals we don't own.
      // They live here rather than in a Tailwind arbitrary-property class so
      // they and `options.itemMetrics` come from the same constants: the two
      // must never drift (see the DIFF_* constants above).
      className="h-full w-full"
      style={
        {
          height: '100%',
          overflow: 'auto',
          '--diffs-gap-block': `${DIFF_GAP_BLOCK}px`,
          '--diffs-line-height': `${DIFF_LINE_HEIGHT}px`,
        } as React.CSSProperties
      }
      renderCodeViewHeader={() => <StepHeaderCard step={currentStep} />}
      // The right-hand side of each file's title bar: the GitHub-style
      // "viewed" check (SPEC §6). Kept to a single compact row so it stays
      // inside the header's `1lh + gap * 3` min-height — a taller control
      // here would silently invalidate DIFF_HEADER_HEIGHT above.
      renderHeaderMetadata={(item: CodeViewItem<ThreadAnnotationMeta>) => {
        const entry = byPath.get(item.id);
        if (entry === undefined) return null;
        const viewed = isViewed(entry);
        return (
          <label
            className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-xs text-chrome-fg-muted"
            title={
              viewed
                ? 'Viewed — unchecks itself when this file changes'
                : 'Mark as viewed'
            }
          >
            <input
              type="checkbox"
              checked={viewed}
              onChange={() => void toggleViewed(entry.path)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className={`flex size-4 items-center justify-center rounded border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-chrome-accent ${
                viewed
                  ? 'border-chrome-accent bg-chrome-accent text-chrome-accent-fg'
                  : 'border-chrome-border'
              }`}
            >
              {viewed && <Check size={12} strokeWidth={3} />}
            </span>
            Viewed
          </label>
        );
      }}
      renderHeaderPrefix={(item: CodeViewItem<ThreadAnnotationMeta>) => (
        <button
          type="button"
          onClick={() => toggleFileCollapsed(item.id)}
          aria-label={item.collapsed === true ? `Expand ${item.id}` : `Collapse ${item.id}`}
          aria-expanded={item.collapsed !== true}
          className="flex shrink-0 items-center justify-center rounded p-0.5 text-chrome-fg-muted transition-colors hover:bg-chrome-bg-sunken hover:text-chrome-fg"
        >
          {item.collapsed === true ? (
            <ChevronRight size={14} strokeWidth={1.5} aria-hidden />
          ) : (
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
          )}
        </button>
      )}
      renderAnnotation={(
        annotation: LineAnnotation<ThreadAnnotationMeta> | DiffLineAnnotation<ThreadAnnotationMeta>,
        item: CodeViewItem<ThreadAnnotationMeta>,
      ) => {
        const meta = annotation.metadata;
        if (meta === undefined) return null;
        if (meta.threadId === DRAFT_THREAD_ID) {
          return (
            <div className="my-1 w-full max-w-xl">
              <CommentComposer
                placeholder="Comment on this line…"
                onSubmit={(body, ask) => void submitDraftThread(body, ask)}
                onCancel={cancelDraftThread}
              />
            </div>
          );
        }
        const thread = threads.find((t) => t.id === meta.threadId);
        if (thread === undefined) return null;
        void item;
        return <ThreadArticle thread={thread} onChanged={() => void reloadThreads()} />;
      }}
    />
  );
}
