/**
 * Right pane: the reading order (SPEC §1, §7). Agent-generated, read-only,
 * regenerable — regenerating supersedes rather than replaces. The threads
 * panel slides over this pane rather than replacing it. Each step's title +
 * explanation render here (not in the code view's header, see
 * ReviewCodeView.tsx) so the explanation stays adjacent to the step's file
 * list; regeneration is only reachable from the command palette once a
 * reading order already exists, so there is no "Generate" affordance beyond
 * the initial empty state below. No pane header: the numbered steps are
 * self-evidently a reading order, so a "Reading order" label would only be
 * restating what's already on screen — that vertical space goes to content
 * instead.
 */
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { runUiState } from '../lib/runState.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { Markdown } from './Markdown.tsx';
import { ThreadsPanel } from './ThreadsPanel.tsx';

export function ReadingOrderPane(): React.JSX.Element {
  const { review, readingOrder, readingOrderRun, selectedPath, setSelectedPath, codeViewRef, generateReadingOrder, threadsPanelOpen } =
    useReview();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const runState = runUiState(readingOrderRun);
  const generating = runState.phase === 'pending';

  const generate = async () => {
    if (review === null) return;
    await generateReadingOrder();
  };

  const jumpTo = (path: string) => {
    setSelectedPath(path);
    codeViewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
  };

  const noReadingOrder = readingOrder === null || readingOrder.steps.length === 0;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {runState.phase === 'error' && (
        // A contained, inset card rather than a full-bleed band with a
        // `border-b`: that treatment dates from when this pane had its own
        // header bar to sit under. Inside a rounded island it would run its
        // background into the island's corners, and the bottom rule would be
        // a third separator style in a pane that just lost the other two.
        <div
          role="alert"
          className="mx-2 mt-2 flex items-start gap-2 rounded-md border border-chrome-danger bg-chrome-danger-bg px-2 py-1.5 text-xs text-chrome-fg"
        >
          <AlertTriangle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-chrome-danger" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Reading order generation failed</span>
            <span className="leading-snug text-chrome-fg-muted">{runState.message}</span>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-4">
        {noReadingOrder ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-xs leading-snug text-chrome-fg-muted">
              No reading order yet. Generate one to get a guided walk through this change.
            </p>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={generating}
              aria-label="Generate reading order"
              className="flex items-center gap-1.5 rounded-md border border-chrome-border px-3 py-1.5 text-body font-medium text-chrome-fg-muted transition-colors hover:border-chrome-border-strong hover:bg-chrome-bg-raised hover:text-chrome-fg disabled:opacity-50"
            >
              <Sparkles size={13} strokeWidth={1.5} aria-hidden />
              {generating ? 'Generating…' : 'Generate reading order'}
            </button>
          </div>
        ) : (
          <>
            {/* Separator decision: earlier revisions gave every step (plus the
                "Also changed" list) its own `border-l`, which stacked into a
                ladder of short disconnected vertical lines down the panel —
                busy and unresolved, especially alongside the "Also changed"
                section's extra `border-t`. Dropped rules entirely in favor of
                indentation + spacing + type weight alone: the chevron/title
                row sits flush left, the explanation and file list indent
                under it by the same amount the chevron icon occupies, and
                the numbered title (font-medium) plus muted explanation text
                already read as a clear hierarchy without a ruled line doing
                the same job redundantly. */}
            <ol className="flex flex-col gap-3">
              {readingOrder.steps.map((step, idx) => {
                const isCollapsed = collapsed.has(step.id);
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(step.id)) next.delete(step.id);
                          else next.add(step.id);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-body text-chrome-fg transition-colors hover:bg-chrome-bg-raised"
                    >
                      {isCollapsed ? (
                        <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                      ) : (
                        <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
                      )}
                      <span className="truncate font-medium">
                        {idx + 1}. {step.title}
                      </span>
                    </button>
                    {!isCollapsed && (
                      <div className="ml-5 pl-2">
                        {/* The step's explanation used to render as a header card
                            above the diff (see ReviewCodeView.tsx); it lives here
                            now, right next to the step's own files. `prose-sm` in
                            `Markdown` is unconstrained, so cap it to this narrow
                            column explicitly rather than letting e.g. a wide code
                            block or table blow out the panel; the trailing right
                            padding keeps its measure off the panel's edge. */}
                        {step.explanationMd.length > 0 && (
                          <div className="min-w-0 overflow-hidden pb-1.5 pr-2 pt-0.5 text-xs leading-snug text-chrome-fg-muted [&_.prose-sm]:text-xs [&_.prose-sm]:leading-snug [&_code]:break-words [&_pre]:overflow-x-auto">
                            <Markdown>{step.explanationMd}</Markdown>
                          </div>
                        )}
                        <ul className="flex flex-col gap-0.5">
                          {step.files.map((f) => (
                            <FileRow
                              key={f.path}
                              path={f.path}
                              title={f.noteMd ?? undefined}
                              selected={selectedPath === f.path}
                              onClick={() => jumpTo(f.path)}
                            />
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {readingOrder.unassignedPaths.length > 0 && (
              // A peer of the numbered steps, not a subsection of the last one —
              // separated by margin rhythm alone (no border-t + border-l stack)
              // so it reads as "the next thing" rather than a fenced-off block.
              <div className="mt-4">
                <h3 className="px-2 py-1 text-body font-medium text-chrome-fg">Also changed</h3>
                <ul className="ml-5 flex flex-col gap-0.5 pl-2">
                  {readingOrder.unassignedPaths.map((path) => (
                    <FileRow
                      key={path}
                      path={path}
                      selected={selectedPath === path}
                      onClick={() => jumpTo(path)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {threadsPanelOpen && <ThreadsPanel />}
    </div>
  );
}

/**
 * A single jump-to-file row, shared between a step's own files and the
 * "Also changed" section below — both need the identical selected-state
 * styling, so this is the one place that defines it.
 */
function FileRow({
  path,
  title,
  selected,
  onClick,
}: {
  path: string;
  title?: string | undefined;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-body transition-colors ${
          selected
            ? 'bg-chrome-accent text-chrome-accent-fg'
            : 'text-chrome-fg-muted hover:bg-chrome-bg-raised hover:text-chrome-fg'
        }`}
        title={title}
      >
        <FileText size={13} strokeWidth={1.5} className="shrink-0" aria-hidden />
        <span className="truncate">{path}</span>
      </button>
    </li>
  );
}
