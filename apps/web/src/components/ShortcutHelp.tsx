/**
 * The `?` shortcut sheet (SPEC §11): every binding from `lib/keymap.ts`,
 * grouped, with modifiers spelled for this platform (⌘/⌥/⇧ on a Mac,
 * Ctrl/Alt/Shift elsewhere — the same `$mod` reading `tinykeys` binds with).
 *
 * Framed like the command palette (same raised surface, shadow and hairline
 * ring, same dimmed backdrop) so the two read as one family. `role="dialog"`
 * also makes `keymapGuard` suppress plain-letter shortcuts while focus is in
 * here; Escape or a backdrop click closes it.
 */
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { SHORTCUT_HELP, formatChord } from '../lib/keymap.ts';

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[10vh] backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        tabIndex={-1}
        // Focus lands on the frame itself so Escape works straight away; it
        // isn't an input, so the app-wide focus ring would only be noise here
        // (same `!` workaround as CommandPalette.tsx).
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-chrome-bg-raised text-chrome-fg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.35),0_0_0_0.5px_light-dark(rgba(20,22,30,0.18),rgba(255,255,255,0.1))] outline-hidden!"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-chrome-border pl-4 pr-2">
          <h2 id="shortcut-help-title" className="text-body font-medium">
            Keyboard shortcuts
          </h2>
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close shortcuts" className="chrome-icon-btn">
            <X size={15} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 overflow-y-auto px-2 pb-3 pt-1 sm:grid-cols-2">
          {SHORTCUT_HELP.map((group) => (
            <section key={group.title} className="min-w-0">
              <h3 className="px-2 pb-1 pt-2.5 text-micro font-medium uppercase tracking-wider text-chrome-fg-subtle">
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
      </div>
    </div>
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
