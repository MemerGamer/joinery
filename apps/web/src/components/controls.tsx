/**
 * Shared chrome controls built on Base UI: the pieces several screens use
 * the same way, so their look and keyboard behaviour live in one place.
 */
import { Toggle } from '@base-ui-components/react/toggle';
import { ToggleGroup } from '@base-ui-components/react/toggle-group';

/**
 * One option of a segmented control: muted until pressed, then raised.
 * Hover only tints the unpressed ones, so the pressed one doesn't flicker.
 */
export const SEGMENT_CLASS =
  'flex h-6 items-center rounded-md px-2.5 text-xs font-medium text-chrome-fg-muted transition-colors not-data-pressed:hover:bg-chrome-bg-hover not-data-pressed:hover:text-chrome-fg data-pressed:bg-chrome-bg-active data-pressed:text-chrome-fg';

/**
 * A single-choice row of buttons (Base UI ToggleGroup): one Tab stop,
 * arrow keys move between options, and exactly one stays pressed —
 * pressing the current one again keeps it, rather than leaving none.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  children,
  className = 'flex gap-1',
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
  className?: string;
  'aria-label': string;
}): React.JSX.Element {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined) onChange(picked);
      }}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </ToggleGroup>
  );
}

/** One option of a `Segmented` row. */
export function Segment({
  value,
  children,
  className = SEGMENT_CLASS,
  title,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
  title?: string | undefined;
}): React.JSX.Element {
  return (
    <Toggle value={value} title={title} className={className}>
      {children}
    </Toggle>
  );
}
