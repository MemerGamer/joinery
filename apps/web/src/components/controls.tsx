/**
 * Shared chrome controls built on Base UI: the pieces several screens use
 * the same way, so their look and keyboard behaviour live in one place.
 */
import { Menu } from '@base-ui-components/react/menu';
import { Switch } from '@base-ui-components/react/switch';
import { Toggle } from '@base-ui-components/react/toggle';
import { Tooltip } from '@base-ui-components/react/tooltip';
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
    <Hint label={title}>
      <Toggle value={value} className={className}>
        {children}
      </Toggle>
    </Hint>
  );
}

/*
 * One look for every pop-up list: Menu, Select and Combobox share the
 * surface, the item row and the group label. Menus are compact (`text-xs`);
 * the settings pickers keep their trigger's `text-body`.
 */
const POPUP_SURFACE_CLASS = 'rounded-md bg-chrome-bg-raised shadow-chrome ring-1 ring-chrome-fg/10 outline-hidden';
/** A menu's popup; callers add a `min-w-*`. */
export const MENU_POPUP_CLASS = `${POPUP_SURFACE_CLASS} p-1 text-xs`;
/** A Select or Combobox popup, which scrolls its own list; callers set the width. */
export const LIST_POPUP_CLASS = `${POPUP_SURFACE_CLASS} flex max-h-[min(22rem,var(--available-height))] flex-col overflow-hidden text-body`;
export const POPUP_ITEM_CLASS =
  'flex h-7 cursor-default select-none items-center gap-2 rounded px-2 text-chrome-fg outline-hidden data-highlighted:bg-chrome-bg-hover';
export const POPUP_LABEL_CLASS = 'px-2 pt-1.5 pb-1 text-micro font-medium text-chrome-fg-subtle';

const MENU_TRIGGER_CLASS =
  'chrome-icon-btn relative size-6 text-chrome-fg-muted aria-expanded:bg-chrome-bg-active aria-expanded:text-chrome-fg';

/** An icon-triggered menu, as the Homebase and Explore panel headers use. */
export function MenuShell({ trigger, label, children }: { trigger: React.ReactNode; label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Menu.Root modal={false}>
      <Hint label={label}>
        <Menu.Trigger aria-label={label} className={MENU_TRIGGER_CLASS}>
          {trigger}
        </Menu.Trigger>
      </Hint>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50">
          <Menu.Popup className={`${MENU_POPUP_CLASS} min-w-48`}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A fixed slot so checked and unchecked rows keep their text aligned. */
export function Tick({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="flex size-3.5 shrink-0 items-center justify-center">{children}</span>;
}

/**
 * The chrome's on/off switch (Base UI Switch). `label` names the setting,
 * not its state: the switch announces on or off itself.
 */
export function ChromeSwitch({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  title,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string | undefined;
}): React.JSX.Element {
  return (
    <Hint label={title}>
      <Switch.Root
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        disabled={disabled}
        aria-label={label}
        className="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-chrome-bg-active p-0.5 transition-colors data-checked:bg-chrome-accent data-disabled:cursor-default data-disabled:opacity-60"
      >
        <Switch.Thumb className="size-3.5 rounded-full bg-chrome-fg shadow-sm transition-transform data-checked:translate-x-3.5 data-checked:bg-chrome-accent-fg" />
      </Switch.Root>
    </Hint>
  );
}

/**
 * App-wide tooltip timing. The first hint waits `delay`; once one has
 * shown, moving onto another within `timeout` opens it at once, and after a
 * longer pause the full delay applies again.
 */
export function HintProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Tooltip.Provider delay={600} closeDelay={0} timeout={400}>
      {children}
    </Tooltip.Provider>
  );
}

/**
 * A hover/focus hint on `children` (Base UI Tooltip), in place of the
 * native `title`. `children` must be one element that takes a ref and
 * props: a DOM element or a Base UI part. A hint is visual only, so an
 * icon-only control still needs its own `aria-label`. The trigger gets
 * `data-popup-open` while the hint shows, so a menu or select trigger under a
 * hint styles its open state on `aria-expanded` instead. No `label`, no hint;
 * the tooltip is only disabled then, so a label that comes and goes doesn't
 * remount the control.
 */
export function Hint({
  label,
  children,
  side = 'top',
}: {
  label: React.ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
  side?: 'top' | 'bottom' | 'left' | 'right';
}): React.JSX.Element {
  const empty = label === undefined || label === null || label === false || label === '';
  return (
    <Tooltip.Root disabled={empty}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} collisionPadding={8} className="z-[100]">
          <Tooltip.Popup className="max-w-80 whitespace-pre-line break-words rounded-md bg-chrome-bg-raised px-2 py-1 font-sans text-xs text-chrome-fg shadow-chrome ring-1 ring-chrome-fg/10 transition-opacity duration-100 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:opacity-0">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
