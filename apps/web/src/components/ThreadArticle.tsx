/**
 * One inline comment thread (SPEC §8), rendered as a `CodeView` line
 * annotation. Outdated threads collapse to their anchor context by default;
 * "changed since you commented" is a softer warning that keeps the thread
 * open. Resolve/reopen and reply round-trip through the API and then ask the
 * parent to reload threads.
 */
import { AlertTriangle, Bot, Check, ChevronDown, History, Loader2, MessageSquare, User } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '@review/core';
import { getAgentModel } from '../lib/agentModel.ts';
import { callApi } from '../lib/apiClient.ts';
import { AskButton } from './AskButton.tsx';
import { CommentComposer } from './CommentComposer.tsx';
import { Markdown } from './Markdown.tsx';
import { ReactionBar } from './ReactionBar.tsx';
import { threadSummary } from '../lib/threadSummary.ts';
import { useReview } from '../state/ReviewContext.tsx';

/**
 * `createdAt` comes from SQLite's `unixepoch()` (seconds); anything that
 * small would render as January 1970 through `Date`. Accept both units so a
 * millisecond timestamp from elsewhere still formats correctly.
 */
function toMs(createdAt: number): number {
  return createdAt < 1e12 ? createdAt * 1000 : createdAt;
}

function formatTimestamp(createdAt: number): string {
  const date = new Date(toMs(createdAt));
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Badge({
  tone,
  icon,
  children,
  onClick,
}: {
  tone: 'warning' | 'success';
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}): React.JSX.Element {
  const cls = `flex h-5 items-center gap-1 rounded-full px-2 text-micro font-medium ${
    tone === 'warning' ? 'bg-chrome-warning-bg text-chrome-warning' : 'bg-chrome-success-bg text-chrome-success'
  }`;
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={`${cls} hover:brightness-110`}>
        {icon}
        {children}
      </button>
    );
  }
  return (
    <span className={cls}>
      {icon}
      {children}
    </span>
  );
}

export function ThreadArticle({
  thread,
  onChanged,
}: {
  thread: Thread;
  onChanged: () => void;
}): React.JSX.Element {
  const { threadRuns, askAgent, activeThreadId, setActiveThreadId } = useReview();
  // Interacting with a thread makes it the "current thread" that `r`
  // resolves and `]`/`[` continue from (see ReviewContext `activeThreadId`).
  const active = activeThreadId === thread.id;
  const markActive = () => {
    if (!active) setActiveThreadId(thread.id);
  };
  const [replying, setReplying] = useState(false);
  // Resolved threads start collapsed; resolving/reopening re-syncs the
  // default (same derive-from-props pattern as `collapsedOutdated` below),
  // while a manual toggle in between is respected until the status changes.
  const [collapsed, setCollapsed] = useState(thread.status === 'resolved');
  const [prevStatus, setPrevStatus] = useState(thread.status);
  if (thread.status !== prevStatus) {
    setPrevStatus(thread.status);
    setCollapsed(thread.status === 'resolved');
  }
  const [collapsedOutdated, setCollapsedOutdated] = useState(thread.outdated);
  const [prevOutdated, setPrevOutdated] = useState(thread.outdated);
  if (thread.outdated !== prevOutdated) {
    setPrevOutdated(thread.outdated);
    setCollapsedOutdated(thread.outdated);
  }

  const resolve = async (resolved: boolean) => {
    await callApi('resolveThread', { params: [thread.id], body: { resolved } });
    onChanged();
  };

  const reply = async (bodyMd: string, askAgent: boolean) => {
    await callApi('reply', {
      params: [thread.id],
      body: { bodyMd, author: 'user', askAgent, ...(askAgent ? { model: getAgentModel() } : {}) },
    });
    setReplying(false);
    onChanged();
  };

  const resolved = thread.status === 'resolved';
  const hasBadges = thread.outdated || thread.changedSinceComment || resolved;
  const commentCount = thread.comments.length;
  const summary = threadSummary(thread.comments[0]?.bodyMd ?? '');

  const runEntry = threadRuns.get(thread.id);
  const runLive = runEntry !== undefined && (runEntry.run.status === 'pending' || runEntry.run.status === 'running');

  if (collapsed) {
    // One diff line tall, no card: a collapsed thread should read as part
    // of the code (like a hunk separator), not as a floating box.
    return (
      <article
        aria-label={`Thread on ${thread.path} line ${thread.startLine} (collapsed)`}
        aria-current={active ? 'true' : undefined}
        onPointerDownCapture={markActive}
        onFocusCapture={markActive}
        className={`w-full max-w-2xl rounded-[4px] font-sans ${active ? 'ring-1 ring-chrome-accent' : ''}`}
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          title={commentCount === 1 ? '1 comment' : `${commentCount} comments`}
          className={`flex h-[22px] w-full min-w-0 items-center gap-2 rounded-[4px] px-2 text-left text-xs transition-colors hover:bg-chrome-bg-hover ${
            resolved ? 'text-chrome-fg-subtle' : 'text-chrome-fg-muted'
          }`}
        >
          <MessageSquare
            size={12}
            strokeWidth={1.75}
            className={`shrink-0 ${resolved ? 'text-chrome-success' : 'text-chrome-accent'}`}
            aria-hidden
          />
          {thread.outdated && <History size={11} strokeWidth={1.75} className="shrink-0 text-chrome-warning" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{summary}</span>
        </button>
      </article>
    );
  }

  return (
    <article
      aria-label={`Thread on ${thread.path} line ${thread.startLine}`}
      aria-current={active ? 'true' : undefined}
      onPointerDownCapture={markActive}
      onFocusCapture={markActive}
      // The current thread (`r` target) swaps the hairline ring for an
      // accent one — a ring is a box-shadow, so it never changes the
      // annotation's measured height.
      className={`my-1.5 flex w-full max-w-2xl flex-col rounded-lg bg-chrome-bg-raised font-sans text-chrome-fg shadow-chrome ring-1 ${
        active ? 'ring-chrome-accent' : 'ring-chrome-fg/8'
      } ${resolved ? 'opacity-80' : ''}`}
    >
      <div className={`flex items-center gap-1.5 pl-2 pr-3 pt-2 ${hasBadges ? 'pb-0.5' : '-mb-1.5'}`}>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-expanded
          aria-label="Collapse thread"
          title="Collapse thread"
          className="chrome-icon-btn size-6 text-chrome-fg-subtle"
        >
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
        </button>
        {hasBadges && (
          <>
          {thread.outdated && (
            <Badge
              tone="warning"
              icon={<History size={11} strokeWidth={1.75} aria-hidden />}
              onClick={() => setCollapsedOutdated((v) => !v)}
            >
              Outdated · {collapsedOutdated ? 'show' : 'hide'} comments
            </Badge>
          )}
          {thread.changedSinceComment && !thread.outdated && (
            <Badge tone="warning" icon={<AlertTriangle size={11} strokeWidth={1.75} aria-hidden />}>
              Changed since you commented
            </Badge>
          )}
          {resolved && (
            <Badge tone="success" icon={<Check size={11} strokeWidth={2} aria-hidden />}>
              Resolved
            </Badge>
          )}
          </>
        )}
      </div>

      {thread.outdated && collapsedOutdated ? (
        <pre className="mx-3 mb-1 mt-2 overflow-x-auto rounded-md bg-chrome-bg-sunken p-2 font-mono text-xs leading-relaxed text-chrome-fg-subtle">
          {thread.anchorContext}
        </pre>
      ) : (
        <ul className="flex flex-col gap-1 py-1">
          {thread.comments.map((comment) => {
            const agent = comment.author === 'agent';
            return (
              <li key={comment.id} className="flex gap-2.5 px-3 py-1.5">
                <span
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${
                    agent ? 'bg-chrome-accent-soft text-chrome-accent' : 'bg-chrome-bg-sunken text-chrome-fg-muted'
                  }`}
                  aria-hidden
                >
                  {agent ? <Bot size={12} strokeWidth={1.75} /> : <User size={12} strokeWidth={1.75} />}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-baseline gap-2 text-micro">
                    <span className="font-medium text-chrome-fg">{agent ? 'Agent' : 'You'}</span>
                    <time className="text-chrome-fg-subtle" dateTime={new Date(toMs(comment.createdAt)).toISOString()}>
                      {formatTimestamp(comment.createdAt)}
                    </time>
                  </div>
                  <Markdown>{comment.bodyMd}</Markdown>
                  <ReactionBar comment={comment} />
                </div>
              </li>
            );
          })}
          {runLive && runEntry !== undefined && (
            <li className="flex gap-2.5 px-3 py-1.5">
              <span
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-chrome-accent-soft text-chrome-accent"
                aria-hidden
              >
                <Bot size={12} strokeWidth={1.75} />
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="shrink-0 text-micro font-medium text-chrome-fg-muted">Thinking…</span>
                {runEntry.lastDelta.length > 0 && (
                  <span className="min-w-0 flex-1 truncate font-mono text-micro text-chrome-fg-subtle">
                    {runEntry.lastDelta}
                  </span>
                )}
                <Loader2 size={12} strokeWidth={2} className="shrink-0 animate-spin text-chrome-fg-subtle" aria-hidden />
              </div>
            </li>
          )}
        </ul>
      )}

      <div className="px-3 pb-2.5 pt-1">
        {replying ? (
          <CommentComposer
            variant="inline"
            placeholder="Reply…"
            onSubmit={(body, ask) => void reply(body, ask)}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" onClick={() => setReplying(true)} className="chrome-btn">
              Reply
            </button>
            <button type="button" onClick={() => void resolve(!resolved)} className="chrome-btn">
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
            <AskButton
              onAsk={() => void askAgent(thread.id)}
              disabled={runLive}
              title="Ask {model} to reply, without composing a new comment"
            />
          </div>
        )}
      </div>
    </article>
  );
}
