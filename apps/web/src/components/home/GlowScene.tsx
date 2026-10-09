/**
 * A glow backdrop's hero: just a gradient from its two colours, in the same
 * band the paintings use — the outer colour at the top into the inner one
 * at the bottom. The page's fade and dither go on top (Homebase), the same
 * as over a painting.
 */
import type { Glow } from '../../lib/covers.ts';

export function GlowScene({ glow, mask }: { glow: Glow; mask: string }): React.JSX.Element {
  const [inner, outer] = glow.colors;
  return (
    <div
      className="absolute inset-0"
      style={{ backgroundImage: `linear-gradient(to bottom, ${outer}, ${inner})`, maskImage: mask, WebkitMaskImage: mask }}
    />
  );
}
