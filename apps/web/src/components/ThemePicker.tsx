/**
 * Diff + chrome theme picker. Colorblind-safe Pierre variants are surfaced
 * directly rather than buried (SPEC §3, §6).
 */
import { useMemo, useState } from 'react';
import { Palette } from 'lucide-react';
import { listThemeOptions } from '../lib/themes.ts';
import { useTheme } from '../state/ThemeContext.tsx';

export function ThemePicker(): React.JSX.Element {
  const { diffTheme, chromeMode, setChromeMode, setDiffTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const options = useMemo(() => listThemeOptions(), []);
  const colorblindSafe = options.filter((o) => o.colorblindSafe);
  const rest = options.filter((o) => !o.colorblindSafe);

  const activeName = chromeMode === 'dark' ? diffTheme.dark : diffTheme.light;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Choose diff theme"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-chrome-border px-2.5 py-1.5 text-xs text-chrome-fg-muted transition-colors hover:border-chrome-border-strong hover:bg-chrome-bg-raised hover:text-chrome-fg"
      >
        <Palette size={16} strokeWidth={1.5} aria-hidden />
        <span className="max-w-24 truncate">{activeName}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Diff theme"
          className="absolute right-0 top-full z-20 mt-2 max-h-80 w-64 overflow-y-auto rounded-md border border-chrome-border bg-chrome-bg-raised p-1.5 shadow-[var(--chrome-shadow)]"
        >
          <div className="flex gap-1 border-b border-chrome-border pb-1.5">
            <button
              type="button"
              onClick={() => setChromeMode('light')}
              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${chromeMode === 'light' ? 'bg-chrome-bg text-chrome-fg' : 'text-chrome-fg-muted hover:text-chrome-fg'}`}
            >
              Light
            </button>
            <button
              type="button"
              onClick={() => setChromeMode('dark')}
              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${chromeMode === 'dark' ? 'bg-chrome-bg text-chrome-fg' : 'text-chrome-fg-muted hover:text-chrome-fg'}`}
            >
              Dark
            </button>
          </div>
          <p className="px-2 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-chrome-fg-subtle">
            Colorblind-safe
          </p>
          <div className="flex flex-col gap-0.5">
            {colorblindSafe.map((opt) => (
              <ThemeRow
                key={opt.name}
                name={opt.name}
                active={opt.name === activeName}
                onClick={() => {
                  setDiffTheme({ ...diffTheme, [chromeMode]: opt.name });
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <p className="px-2 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-chrome-fg-subtle">
            All themes
          </p>
          <div className="flex flex-col gap-0.5">
            {rest.map((opt) => (
              <ThemeRow
                key={opt.name}
                name={opt.name}
                active={opt.name === activeName}
                onClick={() => {
                  setDiffTheme({ ...diffTheme, [chromeMode]: opt.name });
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeRow({
  name,
  active,
  onClick,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`block w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors ${
        active ? 'bg-chrome-accent text-chrome-accent-fg' : 'text-chrome-fg hover:bg-chrome-bg-sunken'
      }`}
    >
      {name}
    </button>
  );
}
