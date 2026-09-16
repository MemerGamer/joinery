/**
 * App chrome light/dark + the selected diff theme name(s). The two are one
 * coordinated, debounced action (SPEC §6, *Themes*): flipping chrome
 * light/dark also flips which half of the diff theme pair is active, and
 * both go through the worker pool's `setRenderOptions` together.
 *
 * `setRenderOptions({ theme })` behaves differently depending on the shape
 * of `theme` (see `@pierre/diffs`' `getHighlighterThemeStyles` /
 * `renderFileWithHighlighter`, in `node_modules/@pierre/diffs/dist`):
 *   - a single theme *name* renders every token with that one theme's
 *     colours baked in directly (shiki's single-theme mode).
 *   - a `{ dark, light }` *pair* renders every token with BOTH colour sets
 *     embedded as CSS custom properties (shiki's dual-theme mode), on the
 *     assumption that host CSS picks between the two per token. This app
 *     has no such CSS, so passing the pair is inert: the worker still
 *     produces "a" render, but nothing ever chooses between the two halves,
 *     so flipping chrome mode changes nothing about the colours shown.
 * The fix is to always pass the single, already-resolved theme name for the
 * *active* chrome mode, not the raw pair.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_DIFF_THEME } from '../lib/themes.ts';
import { DERIVE_CHROME_FROM_THEME, applyDerivedChrome, clearDerivedChrome } from '../lib/deriveChrome.ts';
import { useCoordinatedThemeChange } from '../lib/workerPool.tsx';

export type ChromeMode = 'light' | 'dark';

interface ThemeState {
  chromeMode: ChromeMode;
  diffTheme: { dark: string; light: string };
}

interface ThemeCtxValue extends ThemeState {
  /** Bumped after the chrome palette is re-derived from a diff theme; consumers that snapshot `--chrome-*` via `getComputedStyle` (the file tree) key on it. */
  chromeVersion: number;
  setChromeMode: (mode: ChromeMode) => void;
  setDiffTheme: (theme: { dark: string; light: string }) => void;
}

const ThemeCtx = createContext<ThemeCtxValue | null>(null);

const STORAGE_KEY = 'review-ui:theme';

function activeDiffThemeName(state: ThemeState): string {
  return state.chromeMode === 'dark' ? state.diffTheme.dark : state.diffTheme.light;
}

function readSystemChromeMode(): ChromeMode {
  if (typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function isThemeState(value: unknown): value is ThemeState {
  if (typeof value !== 'object' || value === null) return false;
  const { chromeMode, diffTheme } = value as Record<string, unknown>;
  if (chromeMode !== 'light' && chromeMode !== 'dark') return false;
  if (typeof diffTheme !== 'object' || diffTheme === null) return false;
  const { dark, light } = diffTheme as Record<string, unknown>;
  return typeof dark === 'string' && typeof light === 'string';
}

/** Reads `localStorage` defensively — it throws in some privacy contexts. */
function readStoredThemeState(): ThemeState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isThemeState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistThemeState(state: ThemeState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort only — private/locked-down storage just won't persist.
  }
}

function getInitialThemeState(): ThemeState {
  return readStoredThemeState() ?? { chromeMode: readSystemChromeMode(), diffTheme: DEFAULT_DIFF_THEME };
}

// Computed once at module evaluation, which happens synchronously while
// `main.tsx`'s module graph loads — well before `createRoot(...).render()`
// runs, so this can never race the first paint. Applying it to the DOM here
// (rather than only inside `setChromeMode`) is what keeps the document and
// React's initial state in agreement: previously `data-theme` was only ever
// written inside `setChromeMode`, so on load the document carried no
// `data-theme` at all while React's initial state claimed 'dark'.
const initialThemeState = getInitialThemeState();
document.documentElement.dataset['theme'] = initialThemeState.chromeMode;

export function useTheme(): ThemeCtxValue {
  const ctx = useContext(ThemeCtx);
  if (ctx === null) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<ThemeState>(initialThemeState);
  const [chromeVersion, setChromeVersion] = useState(0);
  const applyCoordinated = useCoordinatedThemeChange();

  const setChromeMode = useCallback((mode: ChromeMode) => {
    document.documentElement.dataset['theme'] = mode;
    setState((s) => ({ ...s, chromeMode: mode }));
  }, []);

  const setDiffTheme = useCallback((theme: { dark: string; light: string }) => {
    setState((s) => ({ ...s, diffTheme: theme }));
  }, []);

  // Drives the coordinated worker-pool theme change from the resolved
  // *active* theme name rather than from inside the state updaters above
  // (state updaters must stay pure — React StrictMode double-invokes them,
  // which would double-fire the side effect). Keyed on the resolved name
  // itself, not on `state`, so flipping chrome mode or picking a diff theme
  // that happens to resolve to the same active name doesn't re-trigger the
  // debounced worker call. This also covers the initial mount: the effect
  // fires once with the module-scope `initialThemeState`'s active name,
  // syncing the worker pool's initial render options (created from the
  // module-scope `highlighterOptions.theme` pair in workerPool.tsx, before
  // this provider — and therefore any stored/system preference — could
  // apply) to the actually-active single theme name.
  const activeName = activeDiffThemeName(state);
  useEffect(() => {
    applyCoordinated({ diffTheme: activeName });
  }, [activeName, applyCoordinated]);

  // Re-tint the chrome from the active diff theme (see lib/deriveChrome.ts).
  // Cancelled on change so a slow theme load can't overwrite a newer one.
  useEffect(() => {
    if (!DERIVE_CHROME_FROM_THEME) return;
    let cancelled = false;
    applyDerivedChrome(activeName, () => cancelled)
      .catch(() => {
        if (!cancelled) clearDerivedChrome();
      })
      .finally(() => {
        if (!cancelled) setChromeVersion((v) => v + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [activeName]);

  useEffect(() => {
    persistThemeState(state);
  }, [state]);

  const value = useMemo<ThemeCtxValue>(
    () => ({ ...state, chromeVersion, setChromeMode, setDiffTheme }),
    [state, chromeVersion, setChromeMode, setDiffTheme],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}
