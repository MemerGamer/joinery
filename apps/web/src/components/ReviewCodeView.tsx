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
import { useMemo } from 'react';
import { makeLoadDiffFiles } from '../lib/diffLoader.ts';
import {
  DRAFT_THREAD_ID,
  useReview,
  type ThreadAnnotationMeta,
} from '../state/ReviewContext.tsx';
import { CommentComposer } from './CommentComposer.tsx';
import { ThreadArticle } from './ThreadArticle.tsx';
import { StepHeaderCard } from './StepHeaderCard.tsx';

export function ReviewCodeView(): React.JSX.Element {
  const {
    review,
    reviewState,
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
  } = useReview();

  const loadDiffFiles = useMemo(
    () => makeLoadDiffFiles(review?.id ?? '', reviewState?.currentRevision),
    [review?.id, reviewState?.currentRevision],
  );

  const options = useMemo<CodeViewReactOptions<ThreadAnnotationMeta, undefined>>(
    () => ({
      diffStyle,
      hunkSeparators: 'line-info',
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
    [diffStyle, loadDiffFiles, startDraftThread],
  );

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
      className="h-full w-full"
      style={{ height: '100%', overflow: 'auto' }}
      renderCodeViewHeader={() => <StepHeaderCard step={currentStep} />}
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
