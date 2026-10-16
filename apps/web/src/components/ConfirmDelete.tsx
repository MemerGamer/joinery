/**
 * A delete trigger that asks first: clicking it opens a small
 * "Cancel / Delete" popover anchored under it, and only the popover's
 * Delete runs `onConfirm`. Outside click or Escape dismisses it.
 */
import { useEffect, useRef, useState } from 'react';

export function ConfirmDelete({
  onConfirm,
  prompt,
  children,
  triggerClassName,
  triggerLabel,
  confirmLabel = 'Delete',
}: {
  onConfirm: () => Promise<void>;
  /** The question shown above the buttons, e.g. "Delete this thread?". */
  prompt: string;
  /** The trigger's content (text or an icon). */
  children: React.ReactNode;
  triggerClassName: string;
  /** Accessible name / tooltip for an icon-only trigger. */
  triggerLabel?: string;
  /** The confirming button's text. */
  confirmLabel?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen((v) => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        className={triggerClassName}
      >
        {children}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={prompt}
          className="absolute right-0 top-full z-20 mt-1 flex w-max max-w-72 flex-col gap-1.5 rounded-md bg-chrome-bg-raised p-2 text-xs shadow-chrome ring-1 ring-chrome-fg/10"
        >
          <span className="text-chrome-fg">{prompt}</span>
          {error !== null && <span className="text-chrome-danger">{error}</span>}
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setOpen(false)} autoFocus className="chrome-btn">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className="flex h-[26px] items-center rounded-md bg-chrome-danger px-2.5 text-xs font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
