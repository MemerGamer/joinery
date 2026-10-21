/**
 * How wide a scrollbar actually is here: 8px for classic scrollbars (macOS
 * with a mouse connected, "Show scroll bars: Always", most other systems),
 * 0 for overlay ones (macOS on a trackpad alone). Layout that tucks the
 * scrollbar into a seam has to know which, or the seam collapses when the
 * scrollbar takes no room. macOS can switch modes while the page is open
 * (a mouse plugged in), so it's re-measured on focus and resize.
 */
import { useEffect, useState } from 'react';

function measure(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
  document.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

export function useScrollbarWidth(): number {
  const [width, setWidth] = useState(measure);
  useEffect(() => {
    const update = () => setWidth(measure());
    window.addEventListener('focus', update);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return width;
}
