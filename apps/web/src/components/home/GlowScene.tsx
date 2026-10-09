/**
 * A glow backdrop's hero: a small landscape painted from its two colours,
 * so it sits in the same band the paintings use and reads like one of
 * them. Back to front: a sky graded from the outer colour down to a
 * horizon lit by the inner one, a sun blooming on that horizon, two soft
 * clouds drifting slowly (motion-safe only), two mountain ridges in
 * darkened outer colour, and film grain over it all so the gradients read
 * as paint rather than CSS. The page's fade and dither go on top (Homebase).
 */
import type { Glow } from '../../lib/covers.ts';

const mix = (a: string, b: string, pct: number): string => `color-mix(in srgb, ${a} ${String(pct)}%, ${b})`;

/** Fractal noise as an SVG data URI, tiled for grain. */
const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

export function GlowScene({ glow, mask }: { glow: Glow; mask: string }): React.JSX.Element {
  const [inner, outer] = glow.colors;
  const sky = `linear-gradient(to bottom, ${mix(outer, 'black', 45)} 0%, ${mix(outer, inner, 70)} 45%, ${mix(inner, outer, 75)} 68%, ${mix(outer, 'black', 55)} 100%)`;
  const sun = `radial-gradient(ellipse 38% 34% at 50% 70%, ${mix(inner, 'white', 70)} 0%, ${mix(inner, 'transparent', 70)} 30%, transparent 70%)`;
  const clouds = [
    `radial-gradient(ellipse 30% 14% at 22% 30%, ${mix(inner, 'transparent', 40)}, transparent 70%)`,
    `radial-gradient(ellipse 36% 12% at 74% 22%, ${mix(mix(inner, 'white', 80), 'transparent', 35)}, transparent 70%)`,
    `radial-gradient(ellipse 24% 10% at 58% 42%, ${mix(inner, 'transparent', 25)}, transparent 70%)`,
  ].join(', ');
  const farRidge = mix(outer, 'black', 55);
  const nearRidge = mix(outer, 'black', 30);

  return (
    <div className="absolute inset-0" style={{ maskImage: mask, WebkitMaskImage: mask }}>
      <div className="absolute inset-0" style={{ backgroundImage: `${sun}, ${sky}` }} />
      {/* Wider than the band so the drift never shows an edge. */}
      <div
        className="absolute -inset-x-[6%] inset-y-0 motion-safe:animate-[home-drift_70s_ease-in-out_infinite_alternate]"
        style={{ backgroundImage: clouds }}
      />
      <svg className="absolute inset-x-0 bottom-0 h-[55%] w-full" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden>
        <path
          d="M0 170 L120 120 L210 150 L330 80 L430 140 L520 110 L640 160 L760 90 L860 130 L980 70 L1090 125 L1200 100 L1200 300 L0 300 Z"
          fill={farRidge}
          opacity={0.75}
        />
        <path
          d="M0 230 L90 200 L200 225 L310 175 L420 215 L560 190 L690 235 L800 195 L930 220 L1050 180 L1200 215 L1200 300 L0 300 Z"
          fill={nearRidge}
        />
      </svg>
      <div className="absolute inset-0 opacity-25 mix-blend-overlay" style={{ backgroundImage: GRAIN, backgroundSize: '220px 220px' }} />
    </div>
  );
}
