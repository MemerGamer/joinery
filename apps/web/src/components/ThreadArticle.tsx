/**
 * One comment thread, rendered inline in the diff through Pierre's
 * annotation slot (SPEC §6, §8). `<article>`-level landmark so a screen
 * reader can walk threads (§3). Outdated threads get a badge and stay put,
 * shown collapsed at their last known position with the captured context.
 */
import { AlertTriangle, Check, History } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '@review/core';
import { callApi } from '../lib/apiClient.ts';
import { CommentComposer } from './CommentComposer.tsx';
import { Markdown } from './Markdown.tsx';

export function ThreadArticle({
  thread,
  onChanged,
}: {
  thread: Thread;
  onChanged: () => void;
}): React.JSX.Element {
  const [replying, setReplying] = useState(false);
  const [collapsedOutdated, setCollapsedOutdated] = useState(thread.outdated);

  const resolve = async (resolved: boolean) => {
    await callApi('resolveThread', { params: [thread.id], body: { resolved } });
    onChanged();
  };

  const reply = async (bodyMd: string, askAgent: boolean) => {
    await callApi('reply', { params: [thread.id], body: { bodyMd, author: 'user', askAgent } });
    setReplying(false);
    onChanged();
  };

  return (
    <article
      aria-label={`Thread on ${thread.path} line ${thread.startLine}`}
      className="my-1 flex w-full max-w-xl flex-col gap-2 rounded-md border border-chrome-border bg-chrome-bg-raised p-2.5 text-chrome-fg shadow-[var(--chrome-shadow)]"
    >
      <div className="flex items-center gap-2">
        {thread.outdated && (
          <button
            type="button"
            onClick={() => setCollapsedOutdated((v) => !v)}
            className="flex items-center gap-1 rounded-full bg-chrome-warning-bg px-1.5 py-0.5 text-[11px] font-medium text-chrome-warning"
          >
            <History size={12} strokeWidth={1.5} aria-hidden />
            Outdated
          </button>
        )}
        {thread.changedSinceComment && !thread.outdated && (
          <span className="flex items-center gap-1 rounded-full bg-chrome-warning-bg px-1.5 py-0.5 text-[11px] font-medium text-chrome-warning">
            <AlertTriangle size={12} strokeWidth={1.5} aria-hidden />
            Changed since you commented
          </span>
        )}
        {thread.status === 'resolved' && (
          <span className="flex items-center gap-1 rounded-full bg-chrome-success/10 px-1.5 py-0.5 text-[11px] font-medium text-chrome-success">
            <Check size={12} strokeWidth={1.5} aria-hidden />
            Resolved
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void resolve(thread.status !== 'resolved')}
          className="rounded-md border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-fg-muted hover:bg-chrome-bg-sunken"
        >
          {thread.status === 'resolved' ? 'Reopen' : 'Resolve'}
        </button>
      </div>

      {thread.outdated && collapsedOutdated ? (
        <pre className="overflow-x-auto rounded bg-chrome-bg-sunken p-1.5 text-[11px] text-chrome-fg-subtle">
          {thread.anchorContext}
        </pre>
      ) : (
        <ul className="flex flex-col gap-2">
          {thread.comments.map((comment) => (
            <li key={comment.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-[11px] text-chrome-fg-subtle">
                <span className="font-medium text-chrome-fg-muted">
                  {comment.author === 'agent' ? 'Agent' : 'You'}
                </span>
                <span>{new Date(comment.createdAt).toLocaleString()}</span>
              </div>
              <Markdown>{comment.bodyMd}</Markdown>
            </li>
          ))}
        </ul>
      )}

      {replying ? (
        <CommentComposer onSubmit={(body, ask) => void reply(body, ask)} onCancel={() => setReplying(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="self-start text-[11px] text-chrome-accent hover:underline"
        >
          Reply
        </button>
      )}
    </article>
  );
}
