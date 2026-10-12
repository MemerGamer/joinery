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
import { bundledThemesInfo } from 'shiki/themes';

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

// `@pierre/theming` only carries display names for its own Pierre themes;
// the Shiki ones would otherwise show their slug ("catppuccin-latte"), so
// take their names from Shiki's own registry ("Catppuccin Latte").
const SHIKI_DISPLAY_NAMES = new Map(bundledThemesInfo.map((t) => [t.id, t.displayName]));

function toOption(name: string, collection: 'pierre' | 'shiki'): ThemeOption {
  const descriptor = allThemes.getTheme(name);
  return {
    name,
    displayName: descriptor?.displayName ?? SHIKI_DISPLAY_NAMES.get(name) ?? name,
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

/**
 * The pair with any slot holding a theme of the other color scheme reset to
 * its default — e.g. a light theme saved as the dark one, back when the
 * picker wrote into the current mode's slot whatever the theme's own scheme.
 */
export function repairDiffThemePair(pair: { dark: string; light: string }): { dark: string; light: string } {
  const fits = (name: string, scheme: 'light' | 'dark') => {
    const own = allThemes.getTheme(name)?.colorScheme;
    return own === undefined || own === scheme;
  };
  return {
    dark: fits(pair.dark, 'dark') ? pair.dark : DEFAULT_DIFF_THEME.dark,
    light: fits(pair.light, 'light') ? pair.light : DEFAULT_DIFF_THEME.light,
  };
}
