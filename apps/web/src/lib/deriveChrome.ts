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
 * Only *surfaces, text and the island frame* are derived. The accent and the semantic colours
 * (danger/warning/success) stay as authored: they carry meaning across
 * themes, and a theme's `textLink.foreground` is not reliably a good
 * button colour.
 *
 * Everything is written as inline custom properties on <html>, so the
 * stylesheet's own values remain the fallback and `clearDerivedChrome`
 * restores them by simply removing the inline overrides. Both take another
 * element instead, to tint only its subtree (onboarding's theme preview).
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
  '--chrome-island-ring',
  '--chrome-island-sheen',
  '--chrome-island-shadow',
] as const;

function mix(a: string, b: string, pctOfB: number): string {
  return `color-mix(in oklab, ${a} ${100 - pctOfB}%, ${b} ${pctOfB}%)`;
}

/** Linear display-p3 → linear sRGB (both share the sRGB transfer curve). */
const P3_TO_SRGB = [
  [1.2249401, -0.2249404, 0],
  [-0.0420569, 1.0420571, 0],
  [-0.0196376, -0.0786361, 1.0983735],
] as const;

/**
 * The colour as opaque `#rrggbb`, or undefined if it can't be read. Most
 * themes are hex already. Translucent hex is rejected: the Pierre "vibrant"
 * themes load with `#00000002`/`#00000001` placeholders in `editor.*` and
 * their real colours in `bg`/`fg` as `color(display-p3 r g b [/ a])`, which
 * colorUtils can't parse — so those are converted (out-of-gamut channels
 * clamped, alpha dropped).
 */
function toHexColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^#[0-9a-f]{6}(ff)?$/i.test(value)) return value.slice(0, 7);
  const p3 = /^color\(display-p3\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(value.trim());
  if (p3 === null) return undefined;
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  const [r, g, b] = [p3[1], p3[2], p3[3]].map((c) => toLinear(Number(c))) as [number, number, number];
  return `#${P3_TO_SRGB.map((row) => {
    const c = fromLinear(row[0] * r + row[1] * g + row[2] * b);
    return Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0');
  }).join('')}`;
}

export function clearDerivedChrome(target: HTMLElement = document.documentElement): void {
  const style = target.style;
  for (const prop of DERIVED_PROPS) style.removeProperty(prop);
}

/** Resolves once the overrides are written. `isStale()` is checked after the
 * async theme load so a slow load can't clobber a newer selection. */
export async function applyDerivedChrome(
  themeName: string,
  isStale: () => boolean = () => false,
  target: HTMLElement = document.documentElement,
): Promise<void> {
  const descriptor = allThemes.getTheme(themeName);
  if (descriptor === undefined) {
    clearDerivedChrome(target);
    return;
  }
  const loaded = await descriptor.load();
  if (isStale()) return;
  // Loaders may resolve to the theme itself or to an ES module wrapping it.
  const theme: ThemeLike = 'default' in loaded ? loaded.default : loaded;
  const colors = theme.colors ?? {};
  const bg = toHexColor(colors['editor.background']) ?? toHexColor(theme.bg);
  const fg = toHexColor(colors['editor.foreground']) ?? toHexColor(theme.fg);
  if (bg === undefined || fg === undefined) {
    clearDerivedChrome(target);
    return;
  }

  const dark = colorUtils.isDarkSurface(bg, fg);
  // Push away from the editor surface toward black (dark) or white (light):
  // sunken sits behind the islands, raised sits on them.
  const toward = dark ? '#000000' : '#ffffff';
  const away = dark ? '#ffffff' : '#000000';
  const muted = colorUtils.deriveMutedFg(fg, bg);

  const style = target.style;
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
  // The island frame (chrome-island): fill does the separating. Light
  // islands are bare white on the grey shell; dark ones get a
  // hairline, a soft top sheen and a shadow.
  set('--chrome-island-ring', dark ? 'var(--chrome-border)' : 'transparent');
  set('--chrome-island-sheen', dark ? 'rgba(255, 255, 255, 0.06)' : 'transparent');
  set('--chrome-island-shadow', dark ? '0 1px 2px rgba(0, 0, 0, 0.25)' : 'none');
}
