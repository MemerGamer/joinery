/**
 * Right pane: the reading order (SPEC §1, §7). Agent-generated, read-only,
 * regenerable — regenerating supersedes rather than replaces. The threads
 * panel slides over this pane rather than replacing it.
 */
import { ChevronDown, ChevronRight, FileText, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { ThreadsPanel } from './ThreadsPanel.tsx';

export function ReadingOrderPane(): React.JSX.Element {
  const { review, readingOrder, selectedPath, setSelectedPath, codeViewRef, reloadReadingOrder, threadsPanelOpen } =
    useReview();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (review === null) return;
    setGenerating(true);
    try {
      await callApi('generateReadingOrder', { params: [review.id], body: {} });
      await reloadReadingOrder();
    } finally {
      setGenerating(false);
    }
  };

  const jumpTo = (path: string) => {
    setSelectedPath(path);
    codeViewRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-chrome-border px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-chrome-fg-muted">
          Reading order
        </h2>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating}
          aria-label="Generate reading order"
          className="flex items-center gap-1.5 rounded-md border border-chrome-border px-2.5 py-1.5 text-[11px] font-medium text-chrome-fg-muted transition-colors hover:border-chrome-border-strong hover:bg-chrome-bg-raised hover:text-chrome-fg disabled:opacity-50"
        >
          <Sparkles size={13} strokeWidth={1.5} aria-hidden />
          {generating ? 'Generating…' : 'Generate'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {readingOrder === null || readingOrder.steps.length === 0 ? (
          <p className="p-3 text-xs leading-relaxed text-chrome-fg-muted">
            No reading order yet. Generate one to get a guided walk through this change.
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
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
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-chrome-fg transition-colors hover:bg-chrome-bg-raised"
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
                    <ul className="ml-5 flex flex-col gap-0.5 border-l border-chrome-border py-0.5 pl-2.5">
                      {step.files.map((f) => (
                        <li key={f.path}>
                          <button
                            type="button"
                            onClick={() => jumpTo(f.path)}
                            className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-1.5 text-left text-[11px] transition-colors ${
                              selectedPath === f.path
                                ? 'bg-chrome-accent text-chrome-accent-fg'
                                : 'text-chrome-fg-muted hover:bg-chrome-bg-raised hover:text-chrome-fg'
                            }`}
                            title={f.noteMd ?? undefined}
                          >
                            <FileText size={12} strokeWidth={1.5} className="shrink-0" aria-hidden />
                            <span className="truncate">{f.path}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {readingOrder !== null && readingOrder.unassignedPaths.length > 0 && (
          <div className="mt-4 rounded-md border border-dashed border-chrome-border p-3 text-[11px] leading-relaxed text-chrome-fg-muted">
            {readingOrder.unassignedPaths.length} file(s) appeared since this reading order was
            generated and belong to no step.{' '}
            <button type="button" onClick={() => void generate()} className="text-chrome-accent hover:underline">
              Regenerate
            </button>
          </div>
        )}
      </div>

      {threadsPanelOpen && <ThreadsPanel />}
    </div>
  );
}
