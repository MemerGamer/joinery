/**
 * The `?` shortcut sheet: every binding from `lib/keymap.ts`,
 * grouped, with modifiers spelled for this platform (⌘/⌥/⇧ on a Mac,
 * Ctrl/Alt/Shift elsewhere — the same `$mod` reading `tinykeys` binds with).
 *
 * Framed like the command palette (same raised surface, shadow and hairline
 * ring, same dimmed backdrop) so the two read as one family. A Base UI
 * Dialog: it traps focus, and Escape or a backdrop click closes it. Its
 * popup's `role="dialog"` makes `keymapGuard` suppress plain-letter
 * shortcuts while focus is in here.
 */
import { X } from 'lucide-react';
import { Dialog } from '@base-ui-components/react/dialog';
import { useRef } from 'react';
import { SHORTCUT_HELP, formatChord } from '../lib/keymap.ts';

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Popup
          ref={popupRef}
          // Focus lands on the frame itself rather than the close button.
          initialFocus={popupRef}
          className="fixed left-1/2 top-[10vh] z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-chrome-bg-raised text-chrome-fg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.35),0_0_0_0.5px_light-dark(rgba(20,22,30,0.18),rgba(255,255,255,0.1))] outline-hidden"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-chrome-border pl-4 pr-2">
            <Dialog.Title className="text-body font-medium">Keyboard shortcuts</Dialog.Title>
            <div className="flex-1" />
            <Dialog.Close aria-label="Close shortcuts" className="chrome-icon-btn">
              <X size={15} strokeWidth={1.5} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 overflow-y-auto px-2 pb-3 pt-1 sm:grid-cols-2">
            {SHORTCUT_HELP.map((group) => (
              <section key={group.title} className="min-w-0">
                <h3 className="px-2 pb-1 pt-2.5 text-micro font-medium text-chrome-fg-subtle">
                  {group.title}
                </h3>
                <ul className="flex flex-col">
                  {group.rows.map((row) => (
                    <li
                      key={row.label}
                      className="flex min-h-7 items-center gap-3 rounded-md px-2 text-body text-chrome-fg-muted"
                    >
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {row.chords.map((chord, i) => (
                          <span key={chord} className="flex items-center gap-1.5">
                            {i > 0 && <span className="text-micro text-chrome-fg-subtle">/</span>}
                            <Chord chord={chord} />
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One chord as keycaps; a sequence (`g h`) reads "G then H". */
function Chord({ chord }: { chord: string }): React.JSX.Element {
  const presses = formatChord(chord);
  return (
    <span className="flex items-center gap-1">
      {presses.map((keys, i) => (
        <span key={i} className="flex items-center gap-0.5">
          {i > 0 && <span className="px-0.5 text-micro text-chrome-fg-subtle">then</span>}
          {keys.map((k, j) => (
            <Key key={j}>{k}</Key>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Same keycap as the palette's footer hints (CommandPalette.tsx `Key`). */
function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="flex h-5 min-w-5 items-center justify-center rounded-[4px] bg-chrome-bg-hover px-1 font-sans text-micro text-chrome-fg-muted ring-1 ring-inset ring-chrome-fg/8">
      {children}
    </kbd>
  );
}
