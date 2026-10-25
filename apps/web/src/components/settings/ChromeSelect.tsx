/**
 * A plain pick-one menu in the settings page's style: the same trigger,
 * popup and items as the theme pickers (ThemePicker.tsx), without the
 * search, on Base UI's Select.
 */
import { Select } from '@base-ui-components/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { LIST_POPUP_CLASS, POPUP_ITEM_CLASS } from '../controls.tsx';

export type ChromeSelectOption<V extends string> = { value: V; label: string };

export function ChromeSelect<V extends string>({
  value,
  options,
  onChange,
  disabled = false,
  label,
  title,
  className = '',
}: {
  value: V;
  options: readonly ChromeSelectOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  /** Names the menu for assistive tech. */
  label: string;
  title?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
    >
      <Select.Trigger
        aria-label={label}
        title={title}
        className={`flex h-8 min-w-0 items-center gap-2 rounded-md border border-chrome-border bg-chrome-bg-raised px-2.5 text-left text-body text-chrome-fg! outline-hidden transition-colors hover:border-chrome-border-strong disabled:opacity-60 data-popup-open:border-chrome-accent ${className}`}
      >
        <Select.Value className="min-w-0 flex-1 truncate" />
        <ChevronDown size={14} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} alignItemWithTrigger={false} className="z-50">
          <Select.Popup className={`${LIST_POPUP_CLASS} min-w-(--anchor-width)`}>
            <Select.List className="min-h-0 overflow-y-auto p-1">
              {options.map((o) => (
                <Select.Item key={o.value} value={o.value} className={POPUP_ITEM_CLASS}>
                  <Select.ItemText className="min-w-0 flex-1 truncate">{o.label}</Select.ItemText>
                  <Select.ItemIndicator className="shrink-0 text-chrome-accent">
                    <Check size={13} strokeWidth={2} aria-hidden />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
