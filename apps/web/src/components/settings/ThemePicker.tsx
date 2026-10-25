/**
 * A theme picker for the settings page's Appearance columns: a button
 * showing the current theme that opens a searchable list (Base UI's
 * Combobox, with its input inside the popup), colorblind-safe themes in
 * their own group first. Hovering or arrowing through the list reports the
 * highlighted theme via `onPreview` (null when nothing is highlighted), so
 * the caller can preview it the way ⌘K's `#` mode does; `onClose` follows
 * every close, after `onChange` when there was a pick.
 */
import { Combobox } from '@base-ui-components/react/combobox';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useMemo } from 'react';
import type { ThemeOption } from '../../lib/themes.ts';
import { LIST_POPUP_CLASS, POPUP_ITEM_CLASS, POPUP_LABEL_CLASS } from '../controls.tsx';


type ThemeGroup = { value: string; items: ThemeOption[] };

export function ThemePicker({
  id,
  options,
  value,
  onChange,
  onPreview,
  onClose,
}: {
  id: string;
  options: readonly ThemeOption[];
  /** The selected theme's name. */
  value: string;
  onChange: (name: string) => void;
  /** The highlighted theme while the list is open, null when nothing is. */
  onPreview: (name: string | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const groups = useMemo<ThemeGroup[]>(
    () =>
      [
        { value: 'Colorblind-safe', items: options.filter((o) => o.colorblindSafe) },
        { value: 'All themes', items: options.filter((o) => !o.colorblindSafe) },
      ].filter((g) => g.items.length > 0),
    [options],
  );
  const selected = options.find((o) => o.name === value) ?? null;

  return (
    <Combobox.Root
      items={groups}
      // A saved name that's no longer a theme (repaired on load, so rare) just shows unselected.
      {...(selected !== null ? { value: selected } : {})}
      onValueChange={(next) => {
        if (next !== null) onChange(next.name);
      }}
      itemToStringLabel={(o: ThemeOption) => o.displayName}
      isItemEqualToValue={(a: ThemeOption, b: ThemeOption) => a.name === b.name}
      onItemHighlighted={(o) => onPreview(o?.name ?? null)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Combobox.Trigger
        id={id}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-chrome-border bg-chrome-bg-raised px-2.5 text-left text-body text-chrome-fg! outline-hidden transition-colors hover:border-chrome-border-strong data-popup-open:border-chrome-accent"
      >
        <span className="min-w-0 flex-1 truncate">{selected?.displayName ?? value}</span>
        <ChevronDown size={14} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8} className="z-50">
          <Combobox.Popup className={`${LIST_POPUP_CLASS} w-(--anchor-width)`}>
            <label className="flex h-9 shrink-0 items-center gap-2 border-b border-chrome-border px-2.5">
              <Search size={13} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
              <Combobox.Input
                placeholder="Search themes…"
                className="h-full min-w-0 flex-1 bg-transparent text-body text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle"
              />
            </label>
            <Combobox.Empty className="px-3 py-6 text-center text-xs text-chrome-fg-muted empty:hidden">No themes match.</Combobox.Empty>
            <Combobox.List className="min-h-0 overflow-y-auto p-1 empty:hidden">
              {(group: ThemeGroup) => (
                <Combobox.Group key={group.value} items={group.items}>
                  <Combobox.GroupLabel className={POPUP_LABEL_CLASS}>{group.value}</Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(o: ThemeOption) => (
                      <Combobox.Item key={o.name} value={o} className={POPUP_ITEM_CLASS}>
                        <span className="min-w-0 flex-1 truncate">{o.displayName}</span>
                        <Combobox.ItemIndicator className="shrink-0 text-chrome-accent">
                          <Check size={13} strokeWidth={2} aria-hidden />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
