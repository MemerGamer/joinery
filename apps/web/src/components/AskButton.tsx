/**
 * "Ask ▾ Model": a split button. The "Ask" half acts; the model half opens
 * a picker over `AGENT_MODELS`. The pick is shared and remembered
 * (`lib/agentModel.ts`), so every Ask button shows the same model.
 */
import { AGENT_MODELS } from '@joinery/core';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { setAgentModel, useAgentModel } from '../lib/agentModel.ts';

export function AskButton({
  onAsk,
  disabled = false,
  title,
  onPicked,
}: {
  onAsk: () => void;
  disabled?: boolean;
  /** Tooltip for the "Ask" half; `{model}` is replaced with the picked model's label. */
  title: string;
  /** Called after a pick, e.g. to return focus to a textarea. */
  onPicked?: () => void;
}): React.JSX.Element {
  const model = useAgentModel();
  const label = AGENT_MODELS.find((m) => m.id === model)?.label ?? model;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative flex h-[26px] items-stretch rounded-md bg-chrome-bg-hover text-xs font-medium text-chrome-fg-muted">
      <button
        type="button"
        onClick={onAsk}
        disabled={disabled}
        title={title.replace('{model}', label)}
        className="rounded-l-md px-2.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Ask
      </button>
      <span className="my-1.5 w-px bg-chrome-border-strong" aria-hidden />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${label}. Change model`}
        className="flex items-center gap-1 whitespace-nowrap rounded-r-md pl-2 pr-1.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg"
      >
        {label}
        <ChevronDown size={12} strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-32 overflow-hidden rounded-md bg-chrome-bg-raised p-1 shadow-chrome ring-1 ring-chrome-fg/10"
        >
          {AGENT_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === model}
              onClick={() => {
                setAgentModel(m.id);
                setOpen(false);
                onPicked?.();
              }}
              className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-chrome-fg hover:bg-chrome-bg-hover"
            >
              <span className="flex-1">{m.label}</span>
              {m.id === model && <Check size={12} strokeWidth={2} className="text-chrome-accent" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
