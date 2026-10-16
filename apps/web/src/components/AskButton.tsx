/**
 * "Ask ▾ Model": a split button. The "Ask" half acts; the model half opens
 * a picker over `AGENT_MODELS`. The pick is shared and remembered
 * (`lib/agentModel.ts`), so every Ask button shows the same model, unless
 * the caller owns the pick (`model` + `onModelChange`), as the reading-order
 * "Generate with" button does.
 */
import { AGENT_MODELS, type AgentModel } from '@joinery/core';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setAgentModel, useAgentModel } from '../lib/agentModel.ts';

export function AskButton({
  onAsk,
  disabled = false,
  title,
  onPicked,
  label: actionLabel = 'Ask',
  model: controlledModel,
  onModelChange,
}: {
  onAsk: () => void;
  disabled?: boolean;
  /** Tooltip for the "Ask" half; `{model}` is replaced with the picked model's label. */
  title: string;
  /** Called after a pick, e.g. to return focus to a textarea. */
  onPicked?: () => void;
  /** The action half's text. */
  label?: string;
  /** A caller-owned pick; without it the shared Ask pick is used. */
  model?: AgentModel;
  onModelChange?: (model: AgentModel) => void;
}): React.JSX.Element {
  const sharedModel = useAgentModel();
  const model = controlledModel ?? sharedModel;
  const label = AGENT_MODELS.find((m) => m.id === model)?.label ?? model;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // The menu is portaled to <body> so ancestors with `overflow` (the diff
  // view) can't clip it; it's positioned from the button's viewport rect.
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || menuRef.current === null) return;
    const r = menuRef.current.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    const menuHeight = AGENT_MODELS.length * 28 + 8;
    setPos(
      window.innerHeight - r.bottom < menuHeight + 8
        ? { right, bottom: window.innerHeight - r.top + 4 }
        : { right, top: r.bottom + 4 },
    );
  }, [open]);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !popupRef.current?.contains(t)) setOpen(false);
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
    <div ref={menuRef} className="relative flex h-[26px] items-stretch rounded-md border bg-chrome-bg-hover text-xs font-medium text-chrome-fg-muted">
      <button
        type="button"
        onClick={onAsk}
        disabled={disabled}
        title={title.replace('{model}', label)}
        className="rounded-l-[5px] px-2.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {actionLabel}
      </button>
      <span className={`my-1.5 w-px bg-chrome-border-strong ${disabled ? 'opacity-50' : ''}`} aria-hidden />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${label}. Change model`}
        className={`flex items-center gap-1 whitespace-nowrap rounded-r-[5px] pl-2 pr-1.5 transition-colors hover:bg-chrome-bg-active hover:text-chrome-fg ${disabled ? 'opacity-50' : ''}`}
      >
        {label}
        <ChevronDown size={12} strokeWidth={2} aria-hidden />
      </button>
      {open && pos !== null && createPortal(
        <div
          ref={popupRef}
          role="menu"
          style={pos}
          className="fixed z-50 min-w-32 overflow-hidden rounded-md bg-chrome-bg-raised p-1 shadow-chrome ring-1 ring-chrome-fg/10"
        >
          {AGENT_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === model}
              onClick={() => {
                if (onModelChange === undefined) setAgentModel(m.id);
                else onModelChange(m.id);
                setOpen(false);
                onPicked?.();
              }}
              className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs text-chrome-fg hover:bg-chrome-bg-hover"
            >
              <span className="flex-1">{m.label}</span>
              {m.id === model && <Check size={12} strokeWidth={2} className="text-chrome-accent" aria-hidden />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
