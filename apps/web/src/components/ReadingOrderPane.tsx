/**
 * Right pane: the reading order. Agent-generated, read-only,
 * regenerable — regenerating replaces the previous reading order. The threads
 * panel slides over this pane rather than replacing it. Each step's title +
 * guidance render here (not in the code view's header, see
 * ReviewCodeView.tsx) so the guidance stays adjacent to the step's file
 * list; regeneration is only reachable from the command palette once a
 * reading order already exists, so there is no "Generate" affordance beyond
 * the initial empty state below. The title row doubles as the home for the
 * Threads entry point, since the threads panel slides over this pane.
 */
import { Collapsible } from '@base-ui-components/react/collapsible';
import type { AgentModel } from '@joinery/core';
import { AlertTriangle, Check, ChevronRight, Loader2, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAgentModel, useGenerationModel } from '../lib/agentModel.ts';
import { resolveCurrentStepIndex } from '../lib/reviewNav.ts';
import { runUiState } from '../lib/runState.ts';
import { useReview, useScrolledPath } from '../state/ReviewContext.tsx';
import { AskButton } from './AskButton.tsx';
import { Markdown } from './Markdown.tsx';
import { ThreadsPanel } from './ThreadsPanel.tsx';

export function ReadingOrderPane(): React.JSX.Element {
  const {
    review,
    fileList,
    readingOrder,
    readingOrderRun,
    cancelRun,
    selectedPath,
    setSelectedPath,
    expandFileForNavigation,
    codeViewRef,
    generateReadingOrder,
    threadsPanelOpen,
    toggleThreadsPanel,
    threads,
    currentStepId,
    setCurrentStepId,
    isViewed,
  } = useReview();
  const scrolledPath = useScrolledPath();
  const openThreads = threads.filter((t) => t.status === 'open').length;
  // A step's title and files always show; only its guidance folds. The
  // step you are at unfolds on its own (see below); a step folded or
  // unfolded by hand keeps that until you toggle it again, whatever the
  // reader moves on to.
  const [arrivedStepId, setArrivedStepId] = useState<string | null>(null);
  const [handToggled, setHandToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isExpanded = (stepId: string) => handToggled.get(stepId) ?? stepId === arrivedStepId;
  const stepRefs = useRef(new Map<string, HTMLLIElement>());
  // The step to bring into view once its unfold transition ends — scrolling
  // any earlier would measure it mid-animation, while the step it replaces
  // is still folding up above it.
  const pendingRevealRef = useRef<string | null>(null);
  const reveal = (stepId: string) =>
    stepRefs.current.get(stepId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // Arriving at a step unfolds its guidance and folds the one auto-opened
  // before it, so the pane shows where you are rather than everywhere you've
  // been, then scrolls the pane so the step is on screen — the list can run
  // long too. Arriving also undoes a hand-fold of that step.
  const arrive = (stepId: string | null) => {
    if (stepId === null) return;
    const hasGuidance = readingOrder?.steps.some((s) => s.id === stepId && s.guidance.length > 0) === true;
    if (isExpanded(stepId) || !hasGuidance) reveal(stepId);
    else pendingRevealRef.current = stepId;
    setArrivedStepId(stepId);
    if (handToggled.get(stepId) === false) {
      setHandToggled((prev) => {
        const next = new Map(prev);
        next.delete(stepId);
        return next;
      });
    }
  };

  // You arrive at a step by `n`/`p`, a click, or scrolling the code view into
  // one of its files; whichever happened last wins. A file in several steps
  // resolves to the current step when it is one of them, so landing on a
  // shared file by `n` doesn't bounce back to its first step once the code
  // view scrolls there.
  const currentStepIndex =
    readingOrder === null ? -1 : resolveCurrentStepIndex(readingOrder.steps, currentStepId, selectedPath);
  const currentStepKey = readingOrder?.steps[currentStepIndex]?.id ?? null;
  const scrolledInStep =
    scrolledPath !== null && readingOrder?.steps.some((s) => s.files.some((f) => f.path === scrolledPath)) === true;
  const scrolledStepKey = scrolledInStep
    ? (readingOrder.steps[resolveCurrentStepIndex(readingOrder.steps, currentStepId, scrolledPath)]?.id ?? null)
    : null;
  useEffect(() => arrive(currentStepKey), [currentStepKey]);
  useEffect(() => arrive(scrolledStepKey), [scrolledStepKey]);

  const runState = runUiState(readingOrderRun);
  const generating = runState.phase === 'pending';

  const cancelButton = readingOrderRun !== null && !readingOrderRun.id.startsWith('local_') && (
    <button
      type="button"
      onClick={() => void cancelRun(readingOrderRun.id)}
      className="flex h-[26px] items-center rounded-md bg-chrome-bg-hover px-2.5 text-xs font-medium text-chrome-fg transition-colors hover:bg-chrome-bg-active"
    >
      Cancel
    </button>
  );

  // The empty state's own pick, starting from the model the last reading
  // order was generated with (shared with the palette's generate page), or
  // the Ask pick before any generation.
  const lastGenerationModel = useGenerationModel();
  const askModel = useAgentModel();
  const [pickedModel, setGenerateModel] = useState<AgentModel | null>(null);
  const generateModel = pickedModel ?? lastGenerationModel ?? askModel;

  const generate = async () => {
    if (review === null) return;
    await generateReadingOrder(generateModel);
  };

  // Paths the reading order names that the current revision's diff doesn't
  // have, e.g. after switching revisions.
  const missingPaths = (() => {
    if (readingOrder === null) return [];
    const present = new Set(fileList.map((f) => f.path));
    const missing = new Set<string>();
    for (const step of readingOrder.steps) {
      for (const f of step.files) if (!present.has(f.path)) missing.add(f.path);
    }
    return [...missing];
  })();

  const viewedPaths = new Set(fileList.filter(isViewed).map((f) => f.path));

  const jumpTo = (path: string, stepId?: string) => {
    if (stepId !== undefined) setCurrentStepId(stepId);
    expandFileForNavigation(path);
    setSelectedPath(path);
    codeViewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
  };

  const noReadingOrder = readingOrder === null || readingOrder.steps.length === 0;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-2 pl-4 pr-2">
        <h2 className="text-body font-medium text-chrome-fg">Reading order</h2>
        {/* The empty state's button shows its own progress; this covers a rerun over an existing order. */}
        {generating && !noReadingOrder && (
          <span className="flex items-center gap-1 text-xs text-chrome-fg-subtle">
            <Loader2 size={12} strokeWidth={1.75} className="animate-spin" aria-hidden />
            <span className="mr-1.5">Regenerating…</span>
            {cancelButton}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggleThreadsPanel}
          aria-pressed={threadsPanelOpen}
          title="Threads (T)"
          className="chrome-btn h-6 bg-transparent px-1.5"
        >
          <MessageSquare size={13} strokeWidth={1.75} aria-hidden />
          Threads
          {openThreads > 0 && <span className="tabular-nums text-chrome-fg-subtle">{openThreads}</span>}
        </button>
      </div>
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

      <div className="flex-1 overflow-y-auto px-2 pb-4 pt-1">
        {noReadingOrder ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-xs leading-snug text-chrome-fg-muted">
              No reading order yet. Generate one to get a guided walk through this change.
            </p>
            {generating ? (
              <span className="flex items-center gap-1.5 text-xs text-chrome-fg-subtle">
                <Loader2 size={12} strokeWidth={1.75} className="animate-spin" aria-hidden />
                <span className="mr-1.5">Generating…</span>
                {cancelButton}
              </span>
            ) : (
              <AskButton
                label="Generate with"
                title="Generate a reading order with {model}"
                onAsk={() => void generate()}
                model={generateModel}
                onModelChange={setGenerateModel}
              />
            )}
          </div>
        ) : (
          <>
            {/* Separator decision: earlier revisions gave every step (plus the
                "Also changed" list) its own `border-l`, which stacked into a
                ladder of short disconnected vertical lines down the panel —
                busy and unresolved, especially alongside the "Also changed"
                section's extra `border-t`. Dropped rules entirely in favor of
                indentation + spacing + type weight alone: the chevron/title
                row sits flush left, the guidance and file list indent
                under it by the same amount the chevron icon occupies, and
                the numbered title (font-medium) plus muted guidance text
                already read as a clear hierarchy without a ruled line doing
                the same job redundantly. */}
            <ol className="flex flex-col gap-1">
              {readingOrder.steps.map((step, idx) => {
                const isCollapsed = !isExpanded(step.id);
                const hasGuidance = step.guidance.length > 0;
                const isCurrent = idx === currentStepIndex;
                const heading = (
                  <>
                    <span
                      className={`w-5 shrink-0 text-right font-mono text-micro tabular-nums ${
                        isCurrent ? 'text-chrome-accent' : 'text-chrome-fg-subtle group-hover:text-chrome-fg-muted'
                      }`}
                      aria-hidden
                    >
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    {/* Titles wrap rather than truncate; the number sits on the first
                        line's baseline and the chevron centres on that line. */}
                    <span className="min-w-0 flex-1 break-words font-medium">{step.title}</span>
                    {step.attention !== null && (
                      <span
                        className={`shrink-0 self-start rounded px-1.5 text-micro font-medium ${
                          step.attention === 'focus'
                            ? 'bg-chrome-accent/15 text-chrome-accent'
                            : 'bg-chrome-bg-hover text-chrome-fg-subtle'
                        }`}
                      >
                        {step.attention === 'focus' ? 'Focus' : 'Skim'}
                      </span>
                    )}
                    {hasGuidance && (
                      <span className="flex h-[1lh] shrink-0 items-center self-start" aria-hidden>
                        <ChevronRight
                          size={13}
                          strokeWidth={1.75}
                          className={`text-chrome-fg-subtle transition-transform duration-200 ease-out ${
                            isCollapsed ? '' : 'rotate-90'
                          }`}
                        />
                      </span>
                    )}
                  </>
                );
                return (
                  <Collapsible.Root
                    key={step.id}
                    // The guidance folds; a step without any has nothing to fold.
                    open={hasGuidance && !isCollapsed}
                    onOpenChange={(open) => setHandToggled((prev) => new Map(prev).set(step.id, open))}
                    disabled={!hasGuidance}
                    render={
                      <li
                        ref={(el) => {
                          if (el === null) stepRefs.current.delete(step.id);
                          else stepRefs.current.set(step.id, el);
                        }}
                        aria-current={isCurrent ? 'step' : undefined}
                      />
                    }
                  >
                    {hasGuidance ? (
                      <Collapsible.Trigger className="group flex w-full items-baseline gap-2 rounded-md py-1.5 pl-1.5 pr-2 text-left text-[14px] text-chrome-fg transition-colors hover:bg-chrome-bg-hover">
                        {heading}
                      </Collapsible.Trigger>
                    ) : (
                      <div className="group flex w-full items-baseline gap-2 rounded-md py-1.5 pl-1.5 pr-2 text-left text-[14px] text-chrome-fg">
                        {heading}
                      </div>
                    )}
                    <div className="mb-2 ml-[2.125rem]">
                      {/* Folding animates the panel's height between 0 and Base UI's
                          measured `--collapsible-panel-height`, with a fade; once
                          folded, Base UI hides it, which keeps its links out of the
                          tab order. The file list below never folds. */}
                      {hasGuidance && (
                        <Collapsible.Panel
                          keepMounted
                          onTransitionEnd={(e) => {
                            if (e.target !== e.currentTarget || pendingRevealRef.current !== step.id) return;
                            pendingRevealRef.current = null;
                            reveal(step.id);
                          }}
                          className="h-(--collapsible-panel-height) overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0"
                        >
                          {/* The step's guidance used to render as a header card
                              above the diff (see ReviewCodeView.tsx); it lives here
                              now, right next to the step's own files. `prose-sm` in
                              `Markdown` is unconstrained, so cap it to this narrow
                              column explicitly rather than letting e.g. a wide code
                              block or table blow out the panel; the trailing right
                              padding keeps its measure off the panel's edge. */}
                          <div className="min-w-0 overflow-hidden pb-2 pr-2 pt-0.5 text-body leading-[1.75] text-chrome-fg-muted [&_.prose-sm]:text-body [&_.prose-sm]:leading-[1.75] [&_code]:break-words [&_pre]:overflow-x-auto">
                            <Markdown>{step.guidance}</Markdown>
                          </div>
                        </Collapsible.Panel>
                      )}
                      <ul className="flex flex-col gap-0.5">
                        {step.files.map((f) => (
                          <FileRow
                            key={f.path}
                            path={f.path}
                            title={f.note ?? undefined}
                            viewed={viewedPaths.has(f.path)}
                            onClick={() => jumpTo(f.path, step.id)}
                          />
                        ))}
                      </ul>
                    </div>
                  </Collapsible.Root>
                );
              })}
            </ol>
            {readingOrder.unassignedPaths.length > 0 && (
              // Laid out like one more step (same title row and indent), with
              // a dot in the number column: these files arrived after the
              // order was generated, so they have no place in its sequence.
              <section className="mt-1">
                <h3 className="flex items-baseline gap-2 py-1.5 pl-1.5 pr-2 text-[14px] font-medium text-chrome-fg">
                  <span className="w-5 shrink-0 text-right font-mono text-micro text-chrome-fg-subtle" aria-hidden>
                    ·
                  </span>
                  Also changed
                </h3>
                <div className="mb-2 ml-[2.125rem]">
                  <p className="pb-2 pr-2 pt-0.5 text-body leading-[1.75] text-chrome-fg-muted">
                    Changed after this reading order was generated.
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {readingOrder.unassignedPaths.map((path) => (
                      <FileRow
                        key={path}
                        path={path}
                        viewed={viewedPaths.has(path)}
                        onClick={() => jumpTo(path)}
                      />
                    ))}
                  </ul>
                </div>
              </section>
            )}
            {missingPaths.length > 0 && (
              // Last group, laid out like "Also changed": files the reading
              // order names that this revision's diff doesn't have. Not
              // clickable, since there is nothing to scroll to.
              <section className="mt-1">
                <h3 className="flex items-baseline gap-2 py-1.5 pl-1.5 pr-2 text-[14px] font-medium text-chrome-fg">
                  <span className="w-5 shrink-0 text-right font-mono text-micro text-chrome-fg-subtle" aria-hidden>
                    ·
                  </span>
                  Missing
                  <span className="ml-auto text-xs font-normal text-chrome-fg-subtle">not in this revision</span>
                </h3>
                <ul className="mb-2 ml-[2.125rem] flex flex-col gap-0.5">
                  {missingPaths.map((path) => (
                    <li
                      key={path}
                      title={path}
                      className="flex min-w-0 items-center px-2 py-[3px] font-mono text-xs text-chrome-fg-subtle"
                    >
                      <FilePath path={path} />
                    </li>
                  ))}
                </ul>
              </section>
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
 * "Also changed" section below. No selected state: a clicked row going
 * tinted and staying that way read as stuck, so only hover marks a row.
 */
function FileRow({
  path,
  title,
  viewed,
  onClick,
}: {
  path: string;
  title?: string | undefined;
  viewed: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full min-w-0 items-center gap-1 rounded-[4px] px-2 py-[3px] text-left font-mono text-xs text-chrome-fg-muted transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
        title={title ?? path}
      >
        <FilePath path={path} />
        {viewed && (
          <Check size={12} strokeWidth={2} className="ml-auto shrink-0 text-chrome-success" aria-label="Viewed" />
        )}
      </button>
    </li>
  );
}

/** `dir/sub/` muted, `name.ext` at full weight — the file name is what you scan for. */
function FilePath({ path }: { path: string }): React.JSX.Element {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return <span className="truncate">{path}</span>;
  return (
    <span className="flex min-w-0">
      <span className="truncate opacity-60">{path.slice(0, slash + 1)}</span>
      <span className="shrink-0">{path.slice(slash + 1)}</span>
    </span>
  );
}
