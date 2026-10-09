/**
 * A glow backdrop's hero: just a gradient from its two colours, in the same
 * band the paintings use — the outer colour across the top, warming into
 * the inner one low in the centre. The page's fade and dither go on top
 * (Homebase), the same as over a painting.
 */
import type { Glow } from '../../lib/covers.ts';

export function GlowScene({ glow, mask }: { glow: Glow; mask: string }): React.JSX.Element {
  const [inner, outer] = glow.colors;
  const background = [
    `radial-gradient(ellipse 70% 80% at 50% 85%, ${inner} 0%, transparent 70%)`,
    `linear-gradient(to bottom, ${outer} 0%, color-mix(in srgb, ${outer} 60%, ${inner}) 100%)`,
  ].join(', ');
  return <div className="absolute inset-0" style={{ backgroundImage: background, maskImage: mask, WebkitMaskImage: mask }} />;
}
