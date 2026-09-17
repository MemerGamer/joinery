/**
 * Backdrops for Homebase and Explore. Three kinds:
 *
 *  - solid     the plain sunken shell
 *  - glow      a translucent radial gradient rising from the bottom centre,
 *              laid between the shell's background and its islands
 *  - image     a public-domain painting as a cover band at the top of the
 *              page island (Notion-style), the shell itself staying plain
 *
 * Paintings are served from Wikimedia Commons at render time (all public
 * domain); vendoring them into `public/` is a later decision.
 */
import { useCallback, useState } from 'react';

export interface Glow {
  id: string;
  name: string;
  /** Inner colour (brightest, at the bottom centre) and outer colour (fades out). */
  colors: [string, string];
}

export const GLOWS: Glow[] = [
  { id: 'dawn', name: 'Dawn', colors: ['#f4a7b9', '#ffd6a5'] },
  { id: 'moss', name: 'Moss', colors: ['#74c69d', '#2d6a4f'] },
  { id: 'ink', name: 'Ink', colors: ['#8b95f2', '#3a0ca3'] },
  { id: 'clay', name: 'Clay', colors: ['#f2a07b', '#8a3b2a'] },
  { id: 'sea', name: 'Sea', colors: ['#48cae4', '#0b3d91'] },
  { id: 'graphite', name: 'Graphite', colors: ['#adb5bd', '#495057'] },
];

export interface Painting {
  id: string;
  name: string;
  artist: string;
  /** File name on Wikimedia Commons. */
  file: string;
}

export const PAINTINGS: Painting[] = [
  { id: 'wave', name: 'The Great Wave off Kanagawa', artist: 'Hokusai', file: 'The_Great_Wave_off_Kanagawa.jpg' },
  { id: 'starry', name: 'The Starry Night', artist: 'Van Gogh', file: 'Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg' },
  { id: 'lilies', name: 'Water Lilies', artist: 'Monet', file: 'Claude_Monet_-_Water_Lilies_-_1906,_Ryerson.jpg' },
  { id: 'wanderer', name: 'Wanderer above the Sea of Fog', artist: 'Friedrich', file: 'Caspar_David_Friedrich_-_Wanderer_above_the_sea_of_fog.jpg' },
  { id: 'nocturne', name: 'Nocturne in Black and Gold', artist: 'Whistler', file: 'Whistler-Nocturne_in_black_and_gold.jpg' },
  { id: 'temeraire', name: 'The Fighting Temeraire', artist: 'Turner', file: 'The_Fighting_Temeraire,_JMW_Turner,_National_Gallery.jpg' },
  { id: 'shower', name: 'Sudden Shower over Ōhashi', artist: 'Hiroshige', file: 'Hiroshige_Atake_sous_une_averse_soudaine.jpg' },
  { id: 'comp8', name: 'Composition 8', artist: 'Kandinsky', file: 'Vassily_Kandinsky,_1923_-_Composition_8,_huile_sur_toile,_140_cm_x_201_cm,_Musée_Guggenheim,_New_York.jpg' },
];

export function paintingUrl(p: Painting, width: number): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(p.file)}?width=${String(width)}`;
}

export type Backdrop = { kind: 'solid' } | { kind: 'glow'; id: string } | { kind: 'image'; id: string };

/** The shell's `--cover-bg`: a translucent bottom-centre glow, tall rather than wide, that fades near the top bar. */
export function glowCss(g: Glow): string {
  const [a, b] = g.colors;
  return `radial-gradient(ellipse 60% 95% at 50% 108%, color-mix(in srgb, ${a} 44%, transparent) 0%, color-mix(in srgb, ${b} 22%, transparent) 40%, transparent 80%)`;
}

/** The picker's swatch: the same two colours, as a simple diagonal. */
export function glowSwatch(g: Glow): string {
  const [a, b] = g.colors;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/** Inline style for the shell element, plus the data attribute the CSS keys off. Only the glow paints the shell. */
export function backdropProps(b: Backdrop): { style: React.CSSProperties; 'data-backdrop': Backdrop['kind'] } {
  let bg = 'none';
  if (b.kind === 'glow') {
    const g = GLOWS.find((x) => x.id === b.id);
    if (g !== undefined) bg = glowCss(g);
  }
  return { style: { ['--cover-bg' as string]: bg }, 'data-backdrop': b.kind };
}

/** The painting to show as a cover band, if the backdrop is an image. */
export function coverPainting(b: Backdrop): Painting | null {
  if (b.kind !== 'image') return null;
  return PAINTINGS.find((x) => x.id === b.id) ?? null;
}

const KEY = 'homebase.backdrop';
const DEFAULT: Backdrop = { kind: 'glow', id: 'dawn' };

function load(): Backdrop {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return DEFAULT;
    const kind = (parsed as { kind: unknown }).kind;
    const id = 'id' in parsed && typeof (parsed as { id: unknown }).id === 'string' ? (parsed as { id: string }).id : '';
    if (kind === 'solid') return { kind: 'solid' };
    if (kind === 'glow' && GLOWS.some((g) => g.id === id)) return { kind: 'glow', id };
    if (kind === 'image' && PAINTINGS.some((p) => p.id === id)) return { kind: 'image', id };
    return DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function useBackdrop(): [Backdrop, (b: Backdrop) => void] {
  const [backdrop, set] = useState<Backdrop>(load);
  const update = useCallback((b: Backdrop) => {
    set(b);
    try {
      localStorage.setItem(KEY, JSON.stringify(b));
    } catch {
      /* private mode etc. — the choice just doesn't stick */
    }
  }, []);
  return [backdrop, update];
}
