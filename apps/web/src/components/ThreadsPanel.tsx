/**
 * The threads panel (SPEC §1): slides over the reading-order pane. It is an
 * index and jump-to surface only — threads themselves render inline in the
 * diff via `ThreadArticle`.
 */
import { Check, MessageSquare, X } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '@review/core';
import { useReview } from '../state/ReviewContext.tsx';

export function ThreadsPanel(): React.JSX.Element {
  const { threads, toggleThreadsPanel, setSelectedPath, codeViewRef } = useReview();
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const visible = threads.filter((t) => t.status === filter);

  const jumpTo = (thread: Thread) => {
    setSelectedPath(thread.path);
    codeViewRef.current?.scrollTo({
      type: 'line',
      id: thread.path,
      lineNumber: thread.startLine,
      side: thread.side === 'old' ? 'deletions' : 'additions',
      align: 'center',
    });
  };

  return (
    <div
      role="region"
      aria-label="Threads"
      className="absolute inset-0 z-10 flex flex-col bg-chrome-bg"
    >
      <div className="flex items-center justify-between border-b border-chrome-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-chrome-fg-muted">
          Threads
        </h2>
        <button
          type="button"
          onClick={toggleThreadsPanel}
          aria-label="Close threads panel"
          className="rounded p-1 text-chrome-fg-muted hover:bg-chrome-bg-raised"
        >
          <X size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      <div className="flex gap-1 border-b border-chrome-border p-2">
        <button
          type="button"
          onClick={() => setFilter('open')}
          className={`flex-1 rounded px-2 py-1 text-xs ${filter === 'open' ? 'bg-chrome-bg-sunken text-chrome-fg' : 'text-chrome-fg-muted'}`}
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => setFilter('resolved')}
          className={`flex-1 rounded px-2 py-1 text-xs ${filter === 'resolved' ? 'bg-chrome-bg-sunken text-chrome-fg' : 'text-chrome-fg-muted'}`}
        >
          Resolved
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto p-2">
        {visible.length === 0 && (
          <li className="p-3 text-center text-xs text-chrome-fg-muted">No {filter} threads.</li>
        )}
        {visible.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              onClick={() => jumpTo(thread)}
              className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-chrome-bg-raised"
            >
              <span className="flex items-center gap-1.5 text-[11px] text-chrome-fg-subtle">
                {thread.status === 'resolved' ? (
                  <Check size={12} strokeWidth={1.5} aria-hidden />
                ) : (
                  <MessageSquare size={12} strokeWidth={1.5} aria-hidden />
                )}
                <span className="truncate">
                  {thread.path}:{thread.startLine}
                </span>
              </span>
              <span className="truncate text-xs text-chrome-fg">
                {thread.comments[0]?.bodyMd ?? '(empty)'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
