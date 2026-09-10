/**
 * The comment composer, used both for a new draft thread (opened via the
 * gutter `+` utility, SPEC §6) and for replies within an existing thread.
 * `Enter` submits, `Cmd+Enter` submits and asks an agent to reply (§11).
 */
import { Bot, Send, X } from 'lucide-react';
import { useRef, useState } from 'react';

export function CommentComposer({
  onSubmit,
  onCancel,
  placeholder = 'Leave a comment…',
  autoFocus = true,
}: {
  onSubmit: (bodyMd: string, askAgent: boolean) => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = (askAgent: boolean) => {
    if (value.trim().length === 0) return;
    onSubmit(value, askAgent);
    setValue('');
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-chrome-border-strong bg-chrome-bg-raised p-2">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(true);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit(false);
          } else if (e.key === 'Escape') {
            onCancel?.();
          }
        }}
        placeholder={placeholder}
        rows={3}
        // `outline-hidden` (not `outline-none`, which drops the outline
        // outright under forced-colors mode) defers the visible ring to the
        // page-wide `:focus-visible` rule in styles/index.css; the
        // `focus-visible:border-chrome-accent` here is a second, same-hue
        // cue on the textarea's own border, not a competing treatment.
        className="w-full resize-none rounded border border-chrome-border bg-chrome-bg p-1.5 text-[13px] text-chrome-fg outline-hidden focus-visible:border-chrome-accent"
        aria-label="Comment body"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-chrome-fg-subtle">Markdown supported</span>
        <div className="flex items-center gap-1">
          {onCancel !== undefined && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel comment"
              className="rounded p-1 text-chrome-fg-muted hover:bg-chrome-bg-sunken"
            >
              <X size={14} strokeWidth={1.5} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={() => submit(true)}
            className="flex items-center gap-1 rounded-md border border-chrome-border px-2 py-1 text-xs text-chrome-fg-muted hover:bg-chrome-bg-sunken"
            title="Submit and ask an agent to reply (⌘Enter)"
          >
            <Bot size={14} strokeWidth={1.5} aria-hidden />
            Ask agent
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            className="flex items-center gap-1 rounded-md bg-chrome-accent px-2 py-1 text-xs font-medium text-chrome-accent-fg"
          >
            <Send size={14} strokeWidth={1.5} aria-hidden />
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
