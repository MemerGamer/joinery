/**
 * Backdrops for Homebase and Explore. Three kinds:
 *
 *  - solid     the plain sunken shell
 *  - glow      a two-colour gradient (`GlowScene`), in the same hero band
 *              as the paintings, optionally with a shape layer over it
 *  - image     a public-domain painting as a cover band at the top of the
 *              page island (Notion-style), the shell itself staying plain
 *
 * Paintings (all public domain, from Wikimedia Commons) are vendored in
 * `public/paintings/`, so they're served by this machine and work offline:
 * `<id>.jpg` at most 2400px wide for the cover band, `<id>-thumb.jpg` at
 * 320px for the picker.
 */
import { useCallback, useState } from 'react';
import { useStoredState } from './storedState.ts';

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

/** Shapes drawn over a glow's gradient, in its own colours. */
export const SHAPES = [
  { id: 'none', name: 'None' },
  { id: 'ridges', name: 'Ridges' },
  { id: 'hills', name: 'Hills' },
  { id: 'waves', name: 'Waves' },
  { id: 'sun', name: 'Sun' },
  { id: 'orbs', name: 'Orbs' },
] as const;
export type ShapeId = (typeof SHAPES)[number]['id'];

export interface Painting {
  id: string;
  name: string;
  artist: string;
  /** File name on Wikimedia Commons, where `public/paintings/<id>.jpg` came from. */
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

export function paintingUrl(p: Painting, size: 'full' | 'thumb'): string {
  return size === 'full' ? `/paintings/${p.id}.jpg` : `/paintings/${p.id}-thumb.jpg`;
}

export type Backdrop = { kind: 'solid' } | { kind: 'glow'; id: string; shape: ShapeId } | { kind: 'image'; id: string };

/** The picker's swatch: the same two colours, as a simple diagonal. */
export function glowSwatch(g: Glow): string {
  const [a, b] = g.colors;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/** The data attribute the CSS keys off. Glows and paintings both live in the hero band now, so the shell stays plain. */
export function backdropProps(b: Backdrop): { 'data-backdrop': Backdrop['kind'] } {
  return { 'data-backdrop': b.kind };
}

/** The glow to paint as a hero scene, if the backdrop is a glow. */
export function coverGlow(b: Backdrop): Glow | null {
  if (b.kind !== 'glow') return null;
  return GLOWS.find((x) => x.id === b.id) ?? null;
}

/** The painting to show as a cover band, if the backdrop is an image. */
export function coverPainting(b: Backdrop): Painting | null {
  if (b.kind !== 'image') return null;
  return PAINTINGS.find((x) => x.id === b.id) ?? null;
}

const KEY = 'homebase.backdrop';
const DEFAULT: Backdrop = { kind: 'glow', id: 'dawn', shape: 'none' };

function load(): Backdrop {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) return DEFAULT;
    const kind = (parsed as { kind: unknown }).kind;
    const id = 'id' in parsed && typeof (parsed as { id: unknown }).id === 'string' ? (parsed as { id: string }).id : '';
    if (kind === 'solid') return { kind: 'solid' };
    if (kind === 'glow' && GLOWS.some((g) => g.id === id)) {
      const raw = 'shape' in parsed ? (parsed as { shape: unknown }).shape : undefined;
      const shape = SHAPES.find((s) => s.id === raw)?.id ?? 'none';
      return { kind: 'glow', id, shape };
    }
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

/** How a painting or glow is laid out on Homebase: a banner across the top, or the whole window behind glass panels. */
export type BackdropStyle = 'banner' | 'window';

export const BACKDROP_STYLE_KEY = 'homebase.backdrop-style';

/** Picked in the backdrop switcher and remembered, like the backdrop itself. */
export function useBackdropStyle(): [BackdropStyle, (s: BackdropStyle) => void] {
  const [style, set] = useStoredState<BackdropStyle>(BACKDROP_STYLE_KEY, 'window');
  return [style === 'banner' ? 'banner' : 'window', set];
}
