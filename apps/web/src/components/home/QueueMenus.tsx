/**
 * The "Up for review" panel's two header menus: filter (only requested, per
 * repo) and sort. Icon triggers keep the header to one compact row; the
 * filter icon carries a dot while anything is filtered out.
 */
import { Menu } from '@base-ui-components/react/menu';
import { ArrowDownUp, Check, ListFilter } from 'lucide-react';
import { MenuShell, POPUP_ITEM_CLASS, POPUP_LABEL_CLASS, Tick } from '../controls.tsx';

export type QueueSort = 'effort' | 'newest' | 'oldest';

const SORT_LABELS: readonly { value: QueueSort; label: string }[] = [
  { value: 'effort', label: 'Reading time' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

export function QueueFilterMenu({
  onlyRequested,
  onOnlyRequestedChange,
  repos,
  hiddenRepoIds,
  onRepoToggle,
}: {
  onlyRequested: boolean;
  onOnlyRequestedChange: (on: boolean) => void;
  /** The repos with something in the queue; the repo group only shows for more than one. */
  repos: readonly { id: string; name: string }[];
  hiddenRepoIds: ReadonlySet<string>;
  onRepoToggle: (repoId: string, shown: boolean) => void;
}): React.JSX.Element {
  const active = onlyRequested || repos.some((r) => hiddenRepoIds.has(r.id));
  return (
    <MenuShell
      label="Filter"
      trigger={
        <>
          <ListFilter size={14} strokeWidth={1.75} aria-hidden className={active ? 'text-chrome-fg' : undefined} />
          {active && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-chrome-accent" />}
        </>
      }
    >
      <Menu.CheckboxItem checked={onlyRequested} onCheckedChange={onOnlyRequestedChange} className={POPUP_ITEM_CLASS}>
        <Tick>
          <Menu.CheckboxItemIndicator>
            <Check size={12} strokeWidth={2.25} aria-hidden />
          </Menu.CheckboxItemIndicator>
        </Tick>
        Only requested
      </Menu.CheckboxItem>
      {repos.length > 1 && (
        <>
          <Menu.Separator className="my-1 h-px bg-chrome-border" />
          <Menu.Group>
            <Menu.GroupLabel className={POPUP_LABEL_CLASS}>Repositories</Menu.GroupLabel>
            {repos.map((repo) => (
              <Menu.CheckboxItem
                key={repo.id}
                checked={!hiddenRepoIds.has(repo.id)}
                onCheckedChange={(shown) => onRepoToggle(repo.id, shown)}
                className={POPUP_ITEM_CLASS}
              >
                <Tick>
                  <Menu.CheckboxItemIndicator>
                    <Check size={12} strokeWidth={2.25} aria-hidden />
                  </Menu.CheckboxItemIndicator>
                </Tick>
                <span className="truncate">{repo.name}</span>
              </Menu.CheckboxItem>
            ))}
          </Menu.Group>
        </>
      )}
    </MenuShell>
  );
}

export function QueueSortMenu({ sort, onSortChange }: { sort: QueueSort; onSortChange: (sort: QueueSort) => void }): React.JSX.Element {
  return (
    <MenuShell label="Sort" trigger={<ArrowDownUp size={14} strokeWidth={1.75} aria-hidden />}>
      <Menu.Group>
        <Menu.GroupLabel className={POPUP_LABEL_CLASS}>Sort by</Menu.GroupLabel>
        <Menu.RadioGroup value={sort} onValueChange={(value: QueueSort) => onSortChange(value)}>
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
