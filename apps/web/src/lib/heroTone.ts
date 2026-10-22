/**
 * Whether the top corners of the Homebase hero are light or dark, so the
 * wordmark (left) and the buttons (right) over them can pick colours that
 * read, and the middle too, where the greeting sits over a full-window
 * backdrop. A glow's top is its outer colour; a painting is sampled once from
 * its thumbnail. `null` while a painting loads (`pending`) or if it can't
 * be read: fall back to the chrome mode.
 */
import { useEffect, useState } from 'react';
import { paintingUrl, type Glow, type Painting } from './covers.ts';

export type Tone = 'light' | 'dark';
export interface HeroTones {
  left: Tone | null;
  right: Tone | null;
  /** The upper middle, around the greeting. */
  center: Tone | null;
  /** A painting's thumbnail is still being sampled: the tones aren't known yet. */
  pending: boolean;
}

/** Relative luminance (WCAG) of an sRGB triple in 0–255. */
function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Around where black and white text are equally legible.
const toneOf = (lum: number): Tone => (lum > 0.18 ? 'light' : 'dark');

function hexTone(hex: string): Tone {
  const n = Number.parseInt(hex.slice(1), 16);
  return toneOf(luminance((n >> 16) & 255, (n >> 8) & 255, n & 255));
}

/** A glow's tone a third of the way down: mostly its outer (top) colour, some of the inner. */
function midTone(outer: string, inner: string): Tone {
  const rgb = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  };
  const [a, b] = [rgb(outer), rgb(inner)];
  return toneOf(luminance(a[0] * 0.65 + b[0] * 0.35, a[1] * 0.65 + b[1] * 0.35, a[2] * 0.65 + b[2] * 0.35));
}

/** Average tone of the painting's upper corners (roughly where the top bar lands once it's cropped to the hero) and its upper middle. */
function samplePainting(p: Painting): Promise<HeroTones | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = 40;
      const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      const cornerW = Math.round(w * 0.25);
      const region = (x: number, y: number, rw: number, rh: number): Tone => {
        const { data } = ctx.getImageData(x, Math.round(h * y), rw, Math.max(1, Math.round(h * rh)));
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
        return toneOf(sum / (data.length / 4));
      };
      try {
        resolve({
          left: region(0, 0.1, cornerW, 0.15),
          right: region(w - cornerW, 0.1, cornerW, 0.15),
          // Wide and tall: behind the greeting the picture is blurred, so what shows there is its average over a broad patch.
          center: region(Math.round(w * 0.3), 0.3, Math.round(w * 0.4), 0.3),
          pending: false,
        });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = paintingUrl(p, 'thumb');
  });
}

const NONE: HeroTones = { left: null, right: null, center: null, pending: false };
const PENDING: HeroTones = { ...NONE, pending: true };

/**
 * Samples by painting id, kept for the session: going back to Homebase or
 * to a painting seen before reuses the answer at once, instead of falling
 * back to the chrome mode for a beat (and flashing the wrong colour) while
 * the thumbnail loads again. `null` means it couldn't be read.
 */
const sampledTones = new Map<string, HeroTones | null>();

export function useHeroTones(painting: Painting | null, glow: Glow | null): HeroTones {
  // Bumped when a sample lands, to re-render with the cache's answer.
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (painting === null || sampledTones.has(painting.id)) return;
    let live = true;
    void samplePainting(painting).then((tones) => {
      sampledTones.set(painting.id, tones);
      if (live) setVersion((v) => v + 1);
    });
    return () => {
      live = false;
    };
  }, [painting]);

  if (painting !== null) {
    if (!sampledTones.has(painting.id)) return PENDING;
    return sampledTones.get(painting.id) ?? NONE;
  }
  if (glow !== null) {
    const tone = hexTone(glow.colors[1]);
    return { left: tone, right: tone, center: midTone(glow.colors[1], glow.colors[0]), pending: false };
  }
  return NONE;
}
