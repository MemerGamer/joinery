/**
 * App chrome light/dark + the selected diff theme name(s). The two are one
 * coordinated, debounced action (SPEC §6, *Themes*): flipping chrome
 * light/dark also flips which half of the diff theme pair is active, and
 * both go through the worker pool's `setRenderOptions` together.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { DEFAULT_DIFF_THEME } from '../lib/themes.ts';
import { useCoordinatedThemeChange } from '../lib/workerPool.tsx';

export type ChromeMode = 'light' | 'dark';

interface ThemeState {
  chromeMode: ChromeMode;
  diffTheme: { dark: string; light: string };
}

interface ThemeCtxValue extends ThemeState {
  setChromeMode: (mode: ChromeMode) => void;
  setDiffTheme: (theme: { dark: string; light: string }) => void;
}

const ThemeCtx = createContext<ThemeCtxValue | null>(null);

export function useTheme(): ThemeCtxValue {
  const ctx = useContext(ThemeCtx);
  if (ctx === null) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<ThemeState>({
    chromeMode: 'dark',
    diffTheme: DEFAULT_DIFF_THEME,
  });
  const applyCoordinated = useCoordinatedThemeChange();

  const setChromeMode = useCallback(
    (mode: ChromeMode) => {
      document.documentElement.dataset['theme'] = mode;
      setState((s) => ({ ...s, chromeMode: mode }));
      applyCoordinated({ diffTheme: state.diffTheme });
    },
    [applyCoordinated, state.diffTheme],
  );

  const setDiffTheme = useCallback(
    (theme: { dark: string; light: string }) => {
      setState((s) => ({ ...s, diffTheme: theme }));
      applyCoordinated({ diffTheme: theme });
    },
    [applyCoordinated],
  );

  const value = useMemo<ThemeCtxValue>(
    () => ({ ...state, setChromeMode, setDiffTheme }),
    [state, setChromeMode, setDiffTheme],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}
