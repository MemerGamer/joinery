/**
 * The Pierre worker pool.
 *
 * Theme is pool-owned once a pool exists: `theme`, `lineDiffType`, and
 * `tokenizeMaxLineLength` all come from here, and per-`CodeView` options are
 * ignored. The app's light/dark toggle and the diff theme picker both funnel
 * through `setCoordinatedRenderOptions`, a single debounced action.
 */
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import type { LineDiffTypes } from '@pierre/diffs';
import { type ReactNode, useMemo, useRef } from 'react';
import { DEFAULT_DIFF_THEME } from './themes.ts';

// Vite's worker factory: `worker.format: 'es'` in vite.config.ts is what
// makes this an ES module worker instead of the default (broken) 'iife'.
const workerFactory = (): Worker =>
  new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' });

const poolSize = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

// Module-scope so identity never changes across renders.
const poolOptions = {
  workerFactory,
  poolSize,
  totalASTLRUCacheSize: 100,
};

const highlighterOptions = {
  theme: DEFAULT_DIFF_THEME,
  // Marks every token with its character offset (`data-char`), which is what
  // makes `onTokenEnter`/`onTokenClick` fire: hover and peek (CodeIntel.tsx).
  // Pool-owned like the theme, so it has to be set here, not per CodeView.
  useTokenTransformer: true,
  lineDiffType: 'word-alt' as LineDiffTypes,
  tokenizeMaxLineLength: 3000,
};

export function DiffWorkerPoolProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

export { useWorkerPool };

export interface CoordinatedThemeChange {
  diffTheme?: { dark: string; light: string } | string;
  lineDiffType?: LineDiffTypes;
  tokenizeMaxLineLength?: number;
}

/**
 * One coordinated, debounced action across the app chrome and the diff
 * theme. Callers pass the new diff-theme value; this hook returns a
 * setter that debounces the `setRenderOptions()` call (which clears the
 * render cache and re-renders everything) so rapid picker clicks collapse
 * into a single re-render.
 */
export function useCoordinatedThemeChange(
  debounceMs = 120,
): (change: CoordinatedThemeChange) => void {
  const pool = useWorkerPool();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useMemo(() => {
    return (change: CoordinatedThemeChange) => {
      if (pool === undefined) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void pool.setRenderOptions({
          ...(change.diffTheme !== undefined ? { theme: change.diffTheme } : {}),
          ...(change.lineDiffType !== undefined ? { lineDiffType: change.lineDiffType } : {}),
          ...(change.tokenizeMaxLineLength !== undefined
            ? { tokenizeMaxLineLength: change.tokenizeMaxLineLength }
            : {}),
        });
      }, debounceMs);
    };
  }, [pool, debounceMs]);
}
