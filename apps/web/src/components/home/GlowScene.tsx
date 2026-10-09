/**
 * A glow backdrop's hero: a gradient from its two colours, the outer one at
 * the top into the inner one at the bottom, with an optional shape layer
 * drawn over it in the same two colours (darkened for silhouettes,
 * lightened for the sun and orbs). Used full size in the hero band (with
 * the band's mask) and as a thumbnail in the backdrop picker. The page's
 * fade and dither go on top in Homebase, the same as over a painting.
 */
import type { Glow, ShapeId } from '../../lib/covers.ts';

const mix = (a: string, b: string, pct: number): string => `color-mix(in srgb, ${a} ${String(pct)}%, ${b})`;

/** Landscape silhouettes share one coordinate space, stretched across the bottom of the scene. */
function Silhouettes({ far, near, farColor, nearColor }: { far: string; near: string; farColor: string; nearColor: string }): React.JSX.Element {
  return (
    <svg className="absolute inset-x-0 bottom-0 h-[55%] w-full" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden>
      <path d={far} fill={farColor} opacity={0.75} />
      <path d={near} fill={nearColor} />
    </svg>
  );
}

function Shape({ shape, inner, outer }: { shape: ShapeId; inner: string; outer: string }): React.JSX.Element | null {
  const dark = mix(outer, 'black', 30);
  const darker = mix(outer, 'black', 55);
  const light = mix(inner, 'white', 70);
  switch (shape) {
    case 'none':
      return null;
    case 'ridges':
      return (
        <Silhouettes
          far="M0 170 L120 120 L210 150 L330 80 L430 140 L520 110 L640 160 L760 90 L860 130 L980 70 L1090 125 L1200 100 L1200 300 L0 300 Z"
          near="M0 230 L90 200 L200 225 L310 175 L420 215 L560 190 L690 235 L800 195 L930 220 L1050 180 L1200 215 L1200 300 L0 300 Z"
          farColor={darker}
          nearColor={dark}
        />
      );
    case 'hills':
      return (
        <Silhouettes
          far="M0 160 C150 90 300 90 450 140 C600 190 750 70 900 110 C1020 140 1110 120 1200 100 L1200 300 L0 300 Z"
          near="M0 230 C180 170 360 180 520 220 C680 260 860 170 1020 190 C1100 200 1160 215 1200 220 L1200 300 L0 300 Z"
          farColor={darker}
          nearColor={dark}
        />
      );
    case 'waves':
      return (
        <svg className="absolute inset-x-0 bottom-0 h-[50%] w-full" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden>
          <path d="M0 120 Q150 80 300 120 T600 120 T900 120 T1200 120 L1200 300 L0 300 Z" fill={darker} opacity={0.45} />
          <path d="M0 180 Q150 140 300 180 T600 180 T900 180 T1200 180 L1200 300 L0 300 Z" fill={darker} opacity={0.65} />
          <path d="M0 240 Q150 200 300 240 T600 240 T900 240 T1200 240 L1200 300 L0 300 Z" fill={dark} />
        </svg>
      );
    case 'sun':
      // A disc set into a flat horizon: the circle stays round at any width
      // because it's sized off the scene's height.
      return (
        <>
          <div
            className="absolute bottom-[22%] left-1/2 aspect-square h-[58%] -translate-x-1/2 translate-y-1/2 rounded-full"
            style={{ background: `linear-gradient(to bottom, ${light}, ${inner})` }}
          />
          <div className="absolute inset-x-0 bottom-0 h-[22%]" style={{ background: dark }} />
        </>
      );
    case 'orbs':
      return (
        <>
          <div className="absolute top-[12%] left-[14%] aspect-square h-[46%] rounded-full opacity-55" style={{ background: light }} />
          <div className="absolute top-[40%] left-[58%] aspect-square h-[62%] rounded-full opacity-35" style={{ background: inner }} />
          <div className="absolute top-[8%] left-[74%] aspect-square h-[22%] rounded-full opacity-60" style={{ background: light }} />
          <div className="absolute top-[58%] left-[30%] aspect-square h-[16%] rounded-full opacity-45" style={{ background: dark }} />
        </>
      );
  }
}

export function GlowScene({ glow, shape, mask }: { glow: Glow; shape: ShapeId; mask?: string }): React.JSX.Element {
  const [inner, outer] = glow.colors;
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ backgroundImage: `linear-gradient(to bottom, ${outer}, ${inner})`, ...(mask !== undefined ? { maskImage: mask, WebkitMaskImage: mask } : {}) }}
    >
      <Shape shape={shape} inner={inner} outer={outer} />
    </div>
  );
}
