/**
 * A delete trigger that asks first: clicking it opens a small
 * "Cancel / Delete" Base UI popover anchored under it, where the cursor
 * already is, and only the popover's Delete runs `onConfirm`. Outside
 * click or Escape dismisses it, and focus starts on Cancel.
 */
import { Popover } from '@base-ui-components/react/popover';
import { useRef, useState } from 'react';

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
  const cancelRef = useRef<HTMLButtonElement>(null);

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
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setError(null);
        setOpen(next);
      }}
    >
      <Popover.Trigger aria-label={triggerLabel} title={triggerLabel} className={triggerClassName}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50">
          <Popover.Popup
            initialFocus={cancelRef}
            className="flex w-max max-w-72 flex-col gap-1.5 rounded-md bg-chrome-bg-raised p-2 text-xs shadow-chrome ring-1 ring-chrome-fg/10 outline-hidden"
          >
            <Popover.Title className="text-chrome-fg">{prompt}</Popover.Title>
            {error !== null && <span className="text-chrome-danger">{error}</span>}
            <div className="flex justify-end gap-1.5">
              <Popover.Close ref={cancelRef} className="chrome-btn">
                Cancel
              </Popover.Close>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={busy}
                className="flex h-[26px] items-center rounded-md bg-chrome-danger px-2.5 text-xs font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-50"
              >
                {confirmLabel}
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
