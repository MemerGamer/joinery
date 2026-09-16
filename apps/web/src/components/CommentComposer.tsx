/**
 * The comment composer, used both for a new draft thread (opened via the
 * gutter `+` utility, SPEC §6) and for replies within an existing thread.
 * `Enter` inserts a newline; `Cmd+Enter` submits. "Ask" has no shortcut.
 *
 * The "Ask ▾ Agent" control is a split button: the "Ask" half submits and
 * asks; the agent half only opens a picker. The picker is presentational
 * for now — the choice is held in local state and not sent anywhere yet.
 */
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Placeholder roster until model selection is wired to the backend. */
const AGENTS = ['Fable 5.1', 'Opus 5', 'Sonnet 5', 'Haiku 4.5'] as const;
type Agent = (typeof AGENTS)[number];

export function CommentComposer({
  onSubmit,
  onCancel,
  placeholder = 'Leave a comment…',
  autoFocus = true,
  variant = 'card',
}: {
  onSubmit: (bodyMd: string, askAgent: boolean) => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** `card` floats on the diff (new draft); `inline` sits flush inside a thread card (reply), with no frame of its own. */
  variant?: 'card' | 'inline';
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [agent, setAgent] = useState<Agent>(AGENTS[0]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const empty = value.trim().length === 0;

  // Auto-grow with content: reset to auto so shrinking works, then size to
  // the scroll height. The CSS `max-h-*` on the textarea caps it, after
  // which it scrolls internally.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const submit = (askAgent: boolean) => {
    if (empty) return;
    onSubmit(value, askAgent);
    setValue('');
  };

  // Close the faux menu on outside click / Escape.
  useEffect(() => {
    if (!agentMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setAgentMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAgentMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [agentMenuOpen]);

  return (
    <div
      className={`flex flex-col overflow-visible font-sans ${
        variant === 'card' ? 'rounded-lg bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/8' : 'border-t border-chrome-border'
      }`}
    >
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit(false);
          } else if (e.key === 'Escape') {
            onCancel?.();
          }
        }}
        placeholder={placeholder}
        rows={2}
        // `outline-hidden!`: the app-wide `:focus-visible` ring (index.css)
        // is unlayered and would otherwise beat this utility; the card's own
        // `focus-within` ring is the focused treatment here.
        className={`max-h-72 w-full resize-none overflow-y-auto bg-transparent pb-1 pt-2.5 text-body leading-relaxed text-chrome-fg outline-hidden! placeholder:text-chrome-fg-subtle ${
          variant === 'card' ? 'px-3' : 'px-0'
        }`}
        aria-label="Comment body"
      />
      <div className={`flex flex-wrap items-center justify-end gap-1.5 pb-2 ${variant === 'card' ? 'px-2' : 'px-0'}`}>
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel} className="chrome-btn bg-transparent">
            Cancel
          </button>
        )}

        {/* Split button: "Ask" acts, the model half only picks. */}
        <div ref={menuRef} className="relative flex h-[26px] items-stretch rounded-md bg-chrome-bg-hover text-xs font-medium text-chrome-fg-muted">
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={empty}
            title={`Submit and ask ${agent} to reply`}
            className="rounded-l-md px-2.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg disabled:opacity-50 disabled:hover:bg-transparent"
          >
            Ask
          </button>
          <span className="my-1.5 w-px bg-chrome-border-strong" aria-hidden />
          <button
            type="button"
            onClick={() => setAgentMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={agentMenuOpen}
            aria-label={`Model: ${agent}. Change model`}
            className="flex items-center gap-1 whitespace-nowrap rounded-r-md pl-2 pr-1.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg"
          >
            {agent}
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </button>
          {agentMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 min-w-32 overflow-hidden rounded-md bg-chrome-bg-raised p-1 shadow-chrome ring-1 ring-chrome-fg/10"
            >
              {AGENTS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={name === agent}
                  onClick={() => {
                    setAgent(name);
                    setAgentMenuOpen(false);
                    ref.current?.focus();
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-chrome-fg hover:bg-chrome-bg-hover"
                >
                  <span className="flex-1">{name}</span>
                  {name === agent && <Check size={12} strokeWidth={2} className="text-chrome-accent" aria-hidden />}
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" onClick={() => submit(false)} disabled={empty} title="Comment (⌘Enter)" className="chrome-btn-primary">
          Comment
          <kbd className="font-sans text-micro opacity-70">⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
