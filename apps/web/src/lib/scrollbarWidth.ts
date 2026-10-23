/**
 * How much room the scrollbar of `container`'s scroller (its first child)
 * actually takes: 8px for a classic scrollbar (macOS with a mouse connected,
 * "Show scroll bars: Always", most other systems), 0 for an overlay one
 * (macOS on a trackpad alone) or while nothing overflows. Layout that tucks
 * the scrollbar into a seam has to know which, or the seam collapses when
 * the scrollbar takes no room.
 *
 * Read off the real scroller rather than a probe element: a probe can be
 * styled or switched differently from it, and the scroller's content box
 * changes whenever its scrollbar appears, goes, or changes kind, so a
 * ResizeObserver catches every case (a mouse plugged in included). The
 * scroller is re-found when the container's children change (loading → diff).
 */
import { useEffect, useState } from 'react';

/** `container` from a callback ref (state), so it's picked up whenever it mounts. */
export function useScrollbarWidth(container: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const host = container;
    if (host === null) return;
    let scroller: HTMLElement | null = null;
    const measure = () => setWidth(scroller === null ? 0 : Math.max(0, scroller.offsetWidth - scroller.clientWidth));
    const resize = new ResizeObserver(measure);
    const attach = () => {
      const next = host.firstElementChild instanceof HTMLElement ? host.firstElementChild : null;
      if (next === scroller) return;
      if (scroller !== null) resize.unobserve(scroller);
      scroller = next;
      if (scroller !== null) resize.observe(scroller);
      measure();
    };
    const children = new MutationObserver(attach);
    children.observe(host, { childList: true });
    attach();
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, [container]);
  return width;
}
