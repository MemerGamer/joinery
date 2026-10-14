/**
 * The end of the scroll (`renderCodeViewFooter`): how much is viewed, a
 * one-click "Mark all viewed", and a small confetti burst the first time it
 * scrolls into view (not at all under `prefers-reduced-motion`).
 */
import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useReview } from '../state/ReviewContext.tsx';

const CONFETTI_COLORS = [
  'var(--chrome-accent)',
  'var(--chrome-success)',
  'var(--chrome-warning)',
  'var(--chrome-danger)',
];

/** A fixed fan of pieces: the burst looks the same every time, with no randomness to seed. */
const CONFETTI = Array.from({ length: 14 }, (_, i) => {
  const angle = (-80 + (i / 13) * 160) * (Math.PI / 180);
  const distance = 60 + (i % 3) * 22;
  return {
    dx: Math.round(Math.sin(angle) * distance * 1.4),
    dy: Math.round(-Math.cos(angle) * distance),
    rotate: (i % 2 === 0 ? 1 : -1) * (180 + i * 25),
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    delay: (i % 4) * 30,
  };
});

export function ReviewFooter(): React.JSX.Element | null {
  const { fileList, isViewed, setAllViewed } = useReview();
  const ref = useRef<HTMLDivElement>(null);
  const [burst, setBurst] = useState(false);
  const hasFiles = fileList.length > 0;

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setBurst(true);
        observer.disconnect();
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasFiles]);

  if (!hasFiles) return null;
  const total = fileList.length;
  const viewed = fileList.filter(isViewed).length;

  return (
    <div
      ref={ref}
      className="relative flex items-center justify-center gap-3 px-4 py-10 font-sans text-body text-chrome-fg-muted"
    >
      {burst && (
        <span className="pointer-events-none absolute left-1/2 top-1/2" aria-hidden>
          {CONFETTI.map((c, i) => (
            <span
              key={i}
              className="absolute left-0 top-0 h-2 w-1 rounded-[1px]"
              style={{
                background: c.color,
                animation: `chrome-confetti 900ms ${String(c.delay)}ms cubic-bezier(0.2, 0.7, 0.3, 1) both`,
                ['--dx' as string]: `${String(c.dx)}px`,
                ['--dy' as string]: `${String(c.dy)}px`,
                ['--rot' as string]: `${String(c.rotate)}deg`,
              }}
            />
          ))}
        </span>
      )}
      <span className="tabular-nums">
        {viewed} of {total} {total === 1 ? 'file' : 'files'} viewed
      </span>
      {viewed < total && (
        <button type="button" onClick={() => void setAllViewed(true)} className="chrome-btn">
          <Check size={13} strokeWidth={1.75} aria-hidden />
          Mark all viewed
        </button>
      )}
    </div>
  );
}
