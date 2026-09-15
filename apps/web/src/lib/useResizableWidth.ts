import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drives a single side panel's width: persisted in localStorage per side,
 * dragged via a pointer-capture handle, and nudgeable with arrow keys for
 * keyboard users (the handle exposes role="separator", so arrows are the
 * expected interaction there per the ARIA separator pattern).
 *
 * Pointer coordinates are converted to a width delta with a sign that
 * depends on which edge is being dragged (the left panel grows as the
 * pointer moves right; the right panel grows as it moves left) — that's
 * the one bit `side` controls beyond the storage key.
 */
export function useResizableWidth(
  side: 'left' | 'right',
  { defaultWidth, min, max }: { defaultWidth: number; min: number; max: number },
): {
  width: number;
  handleProps: {
    role: 'separator';
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    tabIndex: number;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  };
} {
  const storageKey = `review-ui.panel-width.${side}`;

  const [width, setWidth] = useState(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null;
    const parsed = stored !== null ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : defaultWidth;
  });

  // Dragging reads/writes this ref rather than `width` directly so the
  // pointermove listener (registered once per drag, not per render) always
  // clamps against the latest values without needing to be torn down and
  // re-added on every pixel of movement.
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const commitWidth = useCallback(
    (next: number) => {
      const clamped = clamp(next, min, max);
      setWidth(clamped);
      window.localStorage.setItem(storageKey, String(clamped));
    },
    [max, min, storageKey],
  );

  useEffect(() => {
    function onPointerMove(event: PointerEvent): void {
      if (dragState.current === null) return;
      const delta = event.clientX - dragState.current.startX;
      const signed = side === 'left' ? delta : -delta;
      commitWidth(dragState.current.startWidth + signed);
    }
    function onPointerUp(): void {
      dragState.current = null;
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [commitWidth, side]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = { startX: event.clientX, startWidth: width };
    },
    [width],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Left/right arrows are framed as "grow/shrink the panel" rather than
      // "move the pointer", so they need the same left/right sign flip as
      // the drag handler above.
      const step = event.shiftKey ? 32 : 8;
      const growKey = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrinkKey = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (event.key === growKey) {
        event.preventDefault();
        commitWidth(width + step);
      } else if (event.key === shrinkKey) {
        event.preventDefault();
        commitWidth(width - step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        commitWidth(min);
      } else if (event.key === 'End') {
        event.preventDefault();
        commitWidth(max);
      }
    },
    [commitWidth, max, min, side, width],
  );

  return {
    width,
    handleProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': Math.round(width),
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
