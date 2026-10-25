/**
 * Explore's Branches heading menus: filter (mine, unmerged, where it
 * lives, recent, review state) and sort. Same icon-trigger menus as the
 * "Up for review" panel (`QueueMenus.tsx`); the filter icon carries a dot
 * while anything is filtered out. The server applies both, so they look
 * through every branch, not just the most recent page.
 */
import { Menu } from '@base-ui-components/react/menu';
import type { BranchSort } from '@joinery/core';
import { ArrowDownUp, Check, ListFilter } from 'lucide-react';
import { MenuShell, POPUP_ITEM_CLASS, POPUP_LABEL_CLASS, Tick } from '../controls.tsx';

export type BranchFilters = {
  mine: boolean;
  unmerged: boolean;
  where: 'any' | 'local' | 'origin';
  /** Committed within the last `RECENT_DAYS`. */
  recent: boolean;
  review: 'any' | 'unreviewed' | 'reviewing';
};

export const NO_BRANCH_FILTERS: BranchFilters = { mine: false, unmerged: false, where: 'any', recent: false, review: 'any' };
export const RECENT_DAYS = 90;

export function branchFiltersActive(f: BranchFilters): boolean {
  return f.mine || f.unmerged || f.where !== 'any' || f.recent || f.review !== 'any';
}

const SORT_LABELS: readonly { value: BranchSort; label: string }[] = [
  { value: 'recent', label: 'Last commit' },
  { value: 'name', label: 'Name' },
  { value: 'ahead', label: 'Most ahead' },
  { value: 'behind', label: 'Most behind' },
];

const WHERE_LABELS: readonly { value: BranchFilters['where']; label: string }[] = [
  { value: 'any', label: 'Anywhere' },
  { value: 'local', label: 'Local' },
  { value: 'origin', label: 'Only on origin' },
];

const REVIEW_LABELS: readonly { value: BranchFilters['review']; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'unreviewed', label: 'Not reviewed' },
  { value: 'reviewing', label: 'Reviewing' },
];

const SEPARATOR = <Menu.Separator className="my-1 h-px bg-chrome-border" />;

function CheckItem({ checked, onChange, children }: { checked: boolean; onChange: (on: boolean) => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onChange} className={POPUP_ITEM_CLASS}>
      <Tick>
        <Menu.CheckboxItemIndicator>
          <Check size={12} strokeWidth={2.25} aria-hidden />
        </Menu.CheckboxItemIndicator>
      </Tick>
      {children}
    </Menu.CheckboxItem>
  );
}

function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <Menu.Group>
      <Menu.GroupLabel className={POPUP_LABEL_CLASS}>{label}</Menu.GroupLabel>
      <Menu.RadioGroup value={value} onValueChange={(v: T) => onChange(v)}>
        {options.map((o) => (
          <Menu.RadioItem key={o.value} value={o.value} className={POPUP_ITEM_CLASS}>
            <Tick>
              <Menu.RadioItemIndicator>
                <Check size={12} strokeWidth={2.25} aria-hidden />
              </Menu.RadioItemIndicator>
            </Tick>
            {o.label}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Group>
  );
}

export function BranchFilterMenu({ filters, onChange }: { filters: BranchFilters; onChange: (filters: BranchFilters) => void }): React.JSX.Element {
  const active = branchFiltersActive(filters);
  const set = <K extends keyof BranchFilters>(key: K, value: BranchFilters[K]) => onChange({ ...filters, [key]: value });
  return (
    <MenuShell
      label="Filter branches"
      trigger={
        <>
          <ListFilter size={14} strokeWidth={1.75} aria-hidden className={active ? 'text-chrome-fg' : undefined} />
          {active && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-chrome-accent" />}
        </>
      }
    >
      <CheckItem checked={filters.mine} onChange={(on) => set('mine', on)}>
        Mine
      </CheckItem>
      <CheckItem checked={filters.unmerged} onChange={(on) => set('unmerged', on)}>
        Unmerged only
      </CheckItem>
      <CheckItem checked={filters.recent} onChange={(on) => set('recent', on)}>
        Last {RECENT_DAYS} days
      </CheckItem>
      {SEPARATOR}
      <RadioGroup label="Where" value={filters.where} options={WHERE_LABELS} onChange={(v) => set('where', v)} />
      {SEPARATOR}
      <RadioGroup label="Review" value={filters.review} options={REVIEW_LABELS} onChange={(v) => set('review', v)} />
      {active && (
        <>
          {SEPARATOR}
          <Menu.Item onClick={() => onChange(NO_BRANCH_FILTERS)} className={POPUP_ITEM_CLASS}>
            <Tick>{null}</Tick>
            Clear filters
          </Menu.Item>
        </>
      )}
    </MenuShell>
  );
}

export function BranchSortMenu({ sort, onChange }: { sort: BranchSort; onChange: (sort: BranchSort) => void }): React.JSX.Element {
  return (
    <MenuShell label="Sort branches" trigger={<ArrowDownUp size={14} strokeWidth={1.75} aria-hidden />}>
      <Menu.Group>
        <Menu.GroupLabel className={POPUP_LABEL_CLASS}>Sort by</Menu.GroupLabel>
        <Menu.RadioGroup value={sort} onValueChange={(value: BranchSort) => onChange(value)}>
          {SORT_LABELS.map(({ value, label }) => (
            <Menu.RadioItem key={value} value={value} closeOnClick className={POPUP_ITEM_CLASS}>
              <Tick>
                <Menu.RadioItemIndicator>
                  <Check size={12} strokeWidth={2.25} aria-hidden />
                </Menu.RadioItemIndicator>
              </Tick>
              {label}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Group>
    </MenuShell>
  );
}
