/**
 * Derives the app's `--chrome-*` surface colours from the active diff theme.
 *
 * The diff renders in its own shadow root with the selected Shiki/Pierre
 * theme's editor background, while the surrounding chrome uses a fixed
 * neutral palette (styles/index.css). With 75 selectable themes the two
 * routinely clash — a warm Gruvbox diff floating inside cool blue-grey
 * islands. This module reads the theme's `editor.background` /
 * `editor.foreground` (falling back to the descriptor's `bg`/`fg`) and
 * re-derives the chrome's surface, border, and text tokens from them, so
 * the chrome always sits on the same hue family as the code it frames.
 *
 * Only *surfaces and text* are derived. The accent and the semantic colours
 * (danger/warning/success) stay as authored: they carry meaning across
 * themes, and a theme's `textLink.foreground` is not reliably a good
 * button colour.
 *
 * Everything is written as inline custom properties on <html>, so the
 * stylesheet's own values remain the fallback and `clearDerivedChrome`
 * restores them by simply removing the inline overrides.
 */
import { colorUtils } from '@pierre/theming/color';
import { themes as allThemes } from '@pierre/theming/themes';
import type { ThemeLike } from '@pierre/theming';

/** Set to `false` to fall back to the stylesheet's fixed palette. */
export const DERIVE_CHROME_FROM_THEME = true;

const DERIVED_PROPS = [
  '--chrome-bg',
  '--chrome-bg-raised',
  '--chrome-bg-sunken',
  '--chrome-bg-hover',
  '--chrome-bg-active',
  '--chrome-border',
  '--chrome-border-strong',
  '--chrome-fg',
  '--chrome-fg-muted',
  '--chrome-fg-subtle',
] as const;

function mix(a: string, b: string, pctOfB: number): string {
  return `color-mix(in oklab, ${a} ${100 - pctOfB}%, ${b} ${pctOfB}%)`;
}

function isHexColor(value: string | undefined): value is string {
  return value !== undefined && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
}

export function clearDerivedChrome(): void {
  const style = document.documentElement.style;
  for (const prop of DERIVED_PROPS) style.removeProperty(prop);
}

/** Resolves once the overrides are written. `isStale()` is checked after the
 * async theme load so a slow load can't clobber a newer selection. */
export async function applyDerivedChrome(themeName: string, isStale: () => boolean = () => false): Promise<void> {
  const descriptor = allThemes.getTheme(themeName);
  if (descriptor === undefined) {
    clearDerivedChrome();
    return;
  }
  const loaded = await descriptor.load();
  if (isStale()) return;
  // Loaders may resolve to the theme itself or to an ES module wrapping it.
  const theme: ThemeLike = 'default' in loaded ? loaded.default : loaded;
  const colors = theme.colors ?? {};
  const bg = isHexColor(colors['editor.background'])
    ? colors['editor.background']
    : isHexColor(theme.bg)
      ? theme.bg
      : undefined;
  const fg = isHexColor(colors['editor.foreground'])
    ? colors['editor.foreground']
    : isHexColor(theme.fg)
      ? theme.fg
      : undefined;
  if (bg === undefined || fg === undefined) {
    clearDerivedChrome();
    return;
  }

  const dark = colorUtils.isDarkSurface(bg, fg);
  // Push away from the editor surface toward black (dark) or white (light):
  // sunken sits behind the islands, raised sits on them.
  const toward = dark ? '#000000' : '#ffffff';
  const away = dark ? '#ffffff' : '#000000';
  const muted = colorUtils.deriveMutedFg(fg, bg);

  const style = document.documentElement.style;
  const set = (prop: (typeof DERIVED_PROPS)[number], value: string) => style.setProperty(prop, value);
  set('--chrome-bg', bg);
  set('--chrome-bg-raised', mix(bg, away, dark ? 3 : 1));
  // Light themes need a bigger step: a 5% tint of white is invisible next
  // to the white islands, and the islands then read as one flat sheet.
  set('--chrome-bg-sunken', dark ? mix(bg, toward, 30) : mix(bg, '#5b6070', 9));
  set('--chrome-bg-hover', mix('transparent', away, dark ? 6 : 4));
  set('--chrome-bg-active', mix('transparent', away, dark ? 10 : 8));
  set('--chrome-border', mix(bg, away, dark ? 9 : 12));
  set('--chrome-border-strong', mix(bg, away, dark ? 16 : 22));
  set('--chrome-fg', fg);
  set('--chrome-fg-muted', muted);
  set('--chrome-fg-subtle', mix(muted, bg, 35));
}
