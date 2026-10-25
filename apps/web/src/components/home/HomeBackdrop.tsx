/**
 * Homebase's picture backdrop, in one of two layouts (the backdrop switcher's Layout):
 *
 *  - banner   `HeroBand`: a band across the top that dissolves into the
 *             plain page and scrolls away with it, under a dot dither
 *  - window   `HomeBackdrop`: the picture fills the whole window behind
 *             the page, fixed while the page scrolls over it
 *
 * The window style stays sharp at the top and goes soft further down:
 * blurred copies of the picture fade in over it, each blurrier one lower
 * down, so the blur builds up gradually over a long stretch and is full
 * from `softBy` (the top of the panels) down. The greeting sits in the
 * late part of that ramp, on a mostly smooth patch of the picture's
 * average tone (which is what its colour is picked from), never on sharp
 * lines, whatever the painting. The copies are plain `filter: blur` on a
 * picture that never changes, so the browser blurs them once and reuses
 * the result; live backdrop blurs would redo the work on every repaint. A tint darkens (in light mode, frosts) the
 * lower part so the panels have something calm to sit on, and the banner's
 * dot dither goes over everything.
 */
import type { Backdrop, Glow, Painting } from '../../lib/covers.ts';
import { paintingUrl } from '../../lib/covers.ts';
import type { ChromeMode } from '../../state/ThemeContext.tsx';
import { GlowScene } from './GlowScene.tsx';

const HERO_MASK = 'linear-gradient(to bottom, black 0%, black 55%, transparent 100%)';
/**
 * Light mode's version. Fading a (usually dark) painting into a light page
 * passes through grey, and over the dark mode's long, even fade that reads
 * as a milky haze across half the hero. So the painting holds longer, then
 * drops away on an eased curve: the grey band stays narrow and low.
 */
const HERO_MASK_LIGHT =
  'linear-gradient(to bottom, black 0%, black 62%, rgba(0,0,0,0.78) 71%, rgba(0,0,0,0.45) 80%, rgba(0,0,0,0.18) 89%, rgba(0,0,0,0.05) 95%, transparent 100%)';
/** The page-colour wash over the hero's lower part, per mode; light mode's is short, for the same reason. */
const HERO_WASH = {
  dark: 'linear-gradient(to bottom, transparent 0%, transparent 40%, color-mix(in srgb, var(--chrome-bg-sunken) 55%, transparent) 75%, var(--chrome-bg-sunken) 100%)',
  light: 'linear-gradient(to bottom, transparent 0%, transparent 80%, var(--chrome-bg-sunken) 100%)',
} as const;

/** A fine dot grid over the picture, for a pixel-art feel; lighter on light themes, where dark dots read as grime rather than texture. */
const DITHER: React.CSSProperties = {
  backgroundImage: 'radial-gradient(light-dark(rgba(0,0,0,0.3), rgba(0,0,0,0.55)) 0.8px, transparent 1px)',
  backgroundSize: '4px 4px',
};

/** The banner style: the painting (or a glow's gradient) dissolves into the page over its lower ~45%. Placed inside the scroller, so it scrolls away. */
export function HeroBand({
  backdrop,
  painting,
  glow,
  mode,
  height,
}: {
  backdrop: Backdrop;
  painting: Painting | null;
  glow: Glow | null;
  mode: ChromeMode;
  height: string;
}): React.JSX.Element {
  const mask = mode === 'light' ? HERO_MASK_LIGHT : HERO_MASK;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden" style={{ height }} aria-hidden>
      {painting !== null ? (
        <img
          src={paintingUrl(painting, 'full')}
          alt=""
          className="absolute inset-0 size-full object-cover"
          style={{ objectPosition: '50% 35%', maskImage: mask, WebkitMaskImage: mask }}
        />
      ) : (
        glow !== null && backdrop.kind === 'glow' && <GlowScene glow={glow} shape={backdrop.shape} mask={mask} />
      )}
      <div className="absolute inset-0" style={{ background: HERO_WASH[mode] }} />
      {/* Dither, masked like the painting so it dissolves with it: on light themes an unmasked grid greys
          the fade-out and ends in a hard edge. */}
      <div className="absolute inset-0 opacity-30 mix-blend-multiply" style={{ ...DITHER, maskImage: mask, WebkitMaskImage: mask }} />
    </div>
  );
}

/** Blur in px, and how far above `softBy` (in px) its copy starts fading in and is fully there. The ranges overlap, so the steps blend. */
const BLUR_STEPS: [number, number, number][] = [
  [2, 360, 250],
  [4, 290, 170],
  [7, 220, 90],
  [12, 150, 0],
];

const TINT =
  'linear-gradient(to bottom, transparent 0%, transparent 22%, ' +
  'light-dark(color-mix(in srgb, var(--chrome-bg-sunken) 30%, transparent), color-mix(in srgb, var(--chrome-bg-sunken) 35%, transparent)) 50%, ' +
  'light-dark(color-mix(in srgb, var(--chrome-bg-sunken) 62%, transparent), color-mix(in srgb, var(--chrome-bg-sunken) 74%, transparent)) 100%)';

/** Darkens the corners a touch so the eye settles in the middle; skipped in light mode, where it reads as dirt. */
const VIGNETTE = 'radial-gradient(ellipse 85% 75% at 50% 40%, transparent 55%, light-dark(transparent, rgba(0,0,0,0.35)) 100%)';

/** The painting, or the glow's scene. */
function Picture({ backdrop, painting, glow }: { backdrop: Backdrop; painting: Painting | null; glow: Glow | null }): React.JSX.Element | null {
  if (painting !== null) {
    return <img src={paintingUrl(painting, 'full')} alt="" className="absolute inset-0 size-full object-cover" style={{ objectPosition: '50% 35%' }} />;
  }
  if (glow !== null && backdrop.kind === 'glow') return <GlowScene glow={glow} shape={backdrop.shape} />;
  return null;
}

/** The window style: the whole window, fixed behind the scroller. */
export function HomeBackdrop({
  backdrop,
  painting,
  glow,
  softBy,
}: {
  backdrop: Backdrop;
  painting: Painting | null;
  glow: Glow | null;
  /** A CSS length from the top: the picture is fully blurred from here down. */
  softBy: string;
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <Picture backdrop={backdrop} painting={painting} glow={glow} />
      {BLUR_STEPS.map(([px, from, to]) => {
        const mask = `linear-gradient(to bottom, transparent calc(${softBy} - ${String(from)}px), black calc(${softBy} - ${String(to)}px))`;
        // The mask applies after the filter, so one element both blurs the copy and fades it in.
        // Exactly over the sharp picture: scaling it up (to push the blur's soft edge off-screen) shifts every
        // shape outward and doubles the outlines. At the sides the blur thins out over the sharp copy beneath,
        // which is the same picture, so it just reads as a little less blurred there.
        return (
          <div key={px} className="absolute inset-0" style={{ filter: `blur(${String(px)}px)`, maskImage: mask, WebkitMaskImage: mask }}>
            <Picture backdrop={backdrop} painting={painting} glow={glow} />
          </div>
        );
      })}
      {/* Vignette over tint: the first background layer paints on top. */}
      <div className="absolute inset-0" style={{ background: `${VIGNETTE}, ${TINT}` }} />
      {/* The banner's dither, here over the whole window: the picture never fades into the page, so nothing to mask. */}
      <div className="absolute inset-0 opacity-30 mix-blend-multiply" style={DITHER} />
    </div>
  );
}
