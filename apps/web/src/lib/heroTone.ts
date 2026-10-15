/**
 * Whether the top corners of the Homebase hero are light or dark, so the
 * wordmark (left) and the buttons (right) over them can pick colours that
 * read. A glow's top is its outer colour; a painting is sampled once from
 * its thumbnail. `null` while a painting loads (or can't be read): fall
 * back to the chrome mode.
 */
import { useEffect, useState } from 'react';
import { paintingUrl, type Glow, type Painting } from './covers.ts';

export type Tone = 'light' | 'dark';
export interface HeroTones {
  left: Tone | null;
  right: Tone | null;
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

/** Average tone of the painting's upper corners — roughly where the top bar lands once it's cropped to the hero. */
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
      const corner = (x: number): Tone => {
        const { data } = ctx.getImageData(x, Math.round(h * 0.1), cornerW, Math.max(1, Math.round(h * 0.15)));
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
        return toneOf(sum / (data.length / 4));
      };
      try {
        resolve({ left: corner(0), right: corner(w - cornerW) });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = paintingUrl(p, 'thumb');
  });
}

const NONE: HeroTones = { left: null, right: null };

export function useHeroTones(painting: Painting | null, glow: Glow | null): HeroTones {
  const [sampled, setSampled] = useState<{ id: string; tones: HeroTones | null } | null>(null);

  useEffect(() => {
    if (painting === null) return;
    let live = true;
    void samplePainting(painting).then((tones) => {
      if (live) setSampled({ id: painting.id, tones });
    });
    return () => {
      live = false;
    };
  }, [painting]);

  if (painting !== null) return (sampled?.id === painting.id ? sampled.tones : null) ?? NONE;
  if (glow !== null) {
    const tone = hexTone(glow.colors[1]);
    return { left: tone, right: tone };
  }
  return NONE;
}
