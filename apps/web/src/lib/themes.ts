/**
 * The diff theme registry (SPEC §6, *Themes — ship all 75*).
 *
 * `@pierre/theming` already ships both collections as a map of lazy loader
 * thunks — 65 Shiki themes (resolved directly by name inside `@pierre/diffs`'
 * highlighter, no registration needed) plus 10 Pierre themes, which the diffs
 * highlighter does not know about until `registerCustomTheme` is called with
 * their loader. Nothing here re-implements a registry; it wires the two
 * existing ones together and registers the Pierre themes exactly once,
 * still fully lazily (the thunk itself is what's deferred).
 */
import { registerCustomTheme } from '@pierre/diffs';
import { pierreThemes, shikiThemes, themes as allThemes } from '@pierre/theming/themes';

export interface ThemeOption {
  name: string;
  colorScheme: 'light' | 'dark' | undefined;
  collection: 'pierre' | 'shiki';
  /** Colorblind-safe Pierre variant — surfaced directly, not buried (§3, §6). */
  colorblindSafe: boolean;
}

const COLORBLIND_RE = /protanopia-deuteranopia|tritanopia/;

function toOption(name: string, collection: 'pierre' | 'shiki'): ThemeOption {
  const descriptor = allThemes.getTheme(name);
  return {
    name,
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

let registered = false;

/** Registers the 10 Pierre theme loaders with the diffs highlighter. Call once, before any CodeView render uses a `pierre-*` theme. Each loader stays lazy — this only tells the highlighter *how* to load a name, it does not import anything until that name is actually selected. */
export function ensurePierreThemesRegistered(): void {
  if (registered) return;
  registered = true;
  for (const descriptor of pierreThemes.getThemes()) {
    registerCustomTheme(descriptor.name, descriptor.load);
  }
}

export const DEFAULT_DIFF_THEME = { dark: 'pierre-dark', light: 'pierre-light' } as const;
