/**
 * The diff theme registry.
 *
 * `@pierre/theming` ships both collections as a map of lazy loader thunks:
 * 65 Shiki themes plus 10 Pierre themes. `@pierre/diffs`' shared highlighter
 * registers the Pierre ones itself on load (`registerThemeIfAbsent`), so
 * nothing here registers anything — registering them again logged a
 * "theme name already registered" console error per theme. This module only
 * lists the options for the pickers.
 */
import { pierreThemes, shikiThemes, themes as allThemes } from '@pierre/theming/themes';

export interface ThemeOption {
  name: string;
  /** Human label from the collection (e.g. "Pierre Dark"); falls back to `name`. */
  displayName: string;
  colorScheme: 'light' | 'dark' | undefined;
  collection: 'pierre' | 'shiki';
  /** Colorblind-safe Pierre variant — surfaced directly, not buried. */
  colorblindSafe: boolean;
}

const COLORBLIND_RE = /protanopia-deuteranopia|tritanopia/;

function toOption(name: string, collection: 'pierre' | 'shiki'): ThemeOption {
  const descriptor = allThemes.getTheme(name);
  return {
    name,
    displayName: descriptor?.displayName ?? name,
    colorScheme: descriptor?.colorScheme,
    collection,
    colorblindSafe: collection === 'pierre' && COLORBLIND_RE.test(name),
  };
}

export function listThemeOptions(): ThemeOption[] {
  const pierre = pierreThemes.getThemeNames().map((n) => toOption(n, 'pierre'));
  const shiki = shikiThemes.getThemeNames().map((n) => toOption(n, 'shiki'));
  return [...pierre, ...shiki];
}

export const DEFAULT_DIFF_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const;
