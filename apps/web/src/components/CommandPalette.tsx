/**
 * `Cmd+K` command palette (SPEC §11): jump to review/file/step/thread, switch
 * revision, switch theme, generate reading order, ask agent.
 */
import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { callApi } from '../lib/apiClient.ts';
import { goReview } from '../lib/router.ts';
import { listThemeOptions } from '../lib/themes.ts';
import { useReview } from '../state/ReviewContext.tsx';
import { useTheme } from '../state/ThemeContext.tsx';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const review = useReview();
  const { chromeMode, diffTheme, setDiffTheme } = useTheme();
  const [reviewList, setReviewList] = useState<{ id: string; branch: string | null }[]>([]);
  const themeOptions = listThemeOptions();

  useEffect(() => {
    if (!open) return;
    callApi('listReviews')
      .then((res) => setReviewList(res.reviews.map((r) => ({ id: r.id, branch: r.branch }))))
      .catch(() => undefined);
  }, [open]);

  const close = () => onOpenChange(false);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]"
      shouldFilter
    >
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg-raised shadow-[var(--chrome-shadow)]">
        <Command.Input
          placeholder="Jump to file, step, thread… switch revision or theme…"
          className="w-full border-b border-chrome-border bg-transparent px-3 py-2.5 text-sm text-chrome-fg outline-none placeholder:text-chrome-fg-subtle"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1">
          <Command.Empty className="p-3 text-center text-xs text-chrome-fg-muted">
            No results.
          </Command.Empty>

          <Command.Group heading="Files" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
            {review.fileList.map((f) => (
              <Command.Item
                key={f.path}
                value={`file ${f.path}`}
                onSelect={() => {
                  review.setSelectedPath(f.path);
                  review.codeViewRef.current?.scrollTo({ type: 'item', id: f.path, align: 'start' });
                  close();
                }}
                className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
              >
                {f.path}
              </Command.Item>
            ))}
          </Command.Group>

          {review.readingOrder !== null && (
            <Command.Group heading="Steps" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
              {review.readingOrder.steps.map((step) => (
                <Command.Item
                  key={step.id}
                  value={`step ${step.title}`}
                  onSelect={() => {
                    const first = step.files[0];
                    if (first !== undefined) {
                      review.setSelectedPath(first.path);
                      review.codeViewRef.current?.scrollTo({ type: 'item', id: first.path, align: 'start' });
                    }
                    close();
                  }}
                  className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
                >
                  {step.title}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Threads" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
            {review.threads.map((t) => (
              <Command.Item
                key={t.id}
                value={`thread ${t.path} ${t.comments[0]?.bodyMd ?? ''}`}
                onSelect={() => {
                  review.setSelectedPath(t.path);
                  review.codeViewRef.current?.scrollTo({
                    type: 'line',
                    id: t.path,
                    lineNumber: t.startLine,
                    side: t.side === 'old' ? 'deletions' : 'additions',
                  });
                  review.toggleThreadsPanel();
                  close();
                }}
                className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
              >
                {t.path}:{t.startLine} — {t.comments[0]?.bodyMd.slice(0, 60) ?? ''}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Revision" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
            {(['working', 'head', 'pr'] as const).map((rev) => (
              <Command.Item
                key={rev}
                value={`revision ${rev}`}
                onSelect={() => {
                  void review.setRevision(rev);
                  close();
                }}
                className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
              >
                Switch to {rev}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Theme" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
            {themeOptions.slice(0, 30).map((opt) => (
              <Command.Item
                key={opt.name}
                value={`theme ${opt.name}`}
                onSelect={() => {
                  setDiffTheme({ ...diffTheme, [chromeMode]: opt.name });
                  close();
                }}
                className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
              >
                Theme: {opt.name}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Reviews" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
            {reviewList.map((r) => (
              <Command.Item
                key={r.id}
                value={`review ${r.branch ?? r.id}`}
                onSelect={() => {
                  goReview(r.id);
                  close();
                }}
                className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
              >
                Open review: {r.branch ?? r.id}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Actions" className="px-2 py-1 text-[11px] text-chrome-fg-subtle">
            <Command.Item
              value="generate reading order"
              onSelect={() => {
                if (review.review !== null) {
                  void callApi('generateReadingOrder', { params: [review.review.id], body: {} });
                }
                close();
              }}
              className="cursor-pointer rounded px-2 py-1.5 text-xs text-chrome-fg data-[selected=true]:bg-chrome-accent data-[selected=true]:text-chrome-accent-fg"
            >
              Generate reading order
            </Command.Item>
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
