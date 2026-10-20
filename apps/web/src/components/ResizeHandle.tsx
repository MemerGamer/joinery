/**
 * The draggable seam between an island panel and the center pane.
 *
 * This is deliberately *not* a flex item. An earlier version sat in the
 * islands row as a `w-2` sibling, which silently tripled the seam it was
 * meant to sit in: a `gap-2` row puts a gap on *each* side of every item, so
 * a handle between two islands produced 8px + 8px handle + 8px = 24px, while
 * the shell's outer edges stayed at 8px — and the seam changed width
 * whenever a panel was toggled. Absolutely positioning it against the
 * panel's edge instead means the row's `gap` is the only thing that decides
 * seam width, so every seam in the layout is identical by construction.
 *
 * It overhangs into the gap (`-right-2`/`-left-2` plus a width wider than
 * the gap) so the hit target stays comfortable even though the visible seam
 * is only 8px. The parent must be `relative` and must not clip overflow.
 */
export function ResizeHandle({
  side,
  className,
  ...handleProps
}: { side: 'left' | 'right' } & React.JSX.IntrinsicElements['div']): React.JSX.Element {
  return (
    <div
      {...handleProps}
      className={[
        'group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none select-none outline-none',
        // Starts 2px outside the panel edge and runs 6px into it, so it
        // stays clear of the diff's scrollbar, which sits in the seam.
        side === 'right' ? '-right-0.5' : '-left-0.5',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Plain line on the panel's own edge: invisible until the handle is hovered or dragged. */}
      <div
        className={`absolute inset-y-2 w-px ${side === 'right' ? 'right-0.5' : 'left-0.5'} bg-transparent transition-colors group-hover:bg-chrome-accent group-active:bg-chrome-accent`}
      />
    </div>
  );
}
