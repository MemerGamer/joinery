/**
 * The "Up for review" panel's two header menus: filter (only requested, per
 * repo) and sort. Icon triggers keep the header to one compact row; the
 * filter icon carries a dot while anything is filtered out.
 */
import { Menu } from '@base-ui-components/react/menu';
import { ArrowDownUp, Check, ListFilter } from 'lucide-react';
import type { ReactNode } from 'react';

export type QueueSort = 'effort' | 'newest' | 'oldest';

const SORT_LABELS: readonly { value: QueueSort; label: string }[] = [
  { value: 'effort', label: 'Reading time' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const TRIGGER_CLASS =
  'chrome-icon-btn relative size-6 text-chrome-fg-muted data-popup-open:bg-chrome-bg-active data-popup-open:text-chrome-fg';
const POPUP_CLASS =
  'min-w-48 rounded-md bg-chrome-bg-raised p-1 text-xs shadow-chrome ring-1 ring-chrome-fg/10 outline-hidden';
const ITEM_CLASS =
  'flex h-7 cursor-default select-none items-center gap-2 rounded px-2 text-chrome-fg outline-hidden data-highlighted:bg-chrome-bg-hover';
const LABEL_CLASS = 'px-2 pt-1.5 pb-1 text-micro font-medium text-chrome-fg-subtle';

function MenuShell({ trigger, label, children }: { trigger: ReactNode; label: string; children: ReactNode }): React.JSX.Element {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label={label} title={label} className={TRIGGER_CLASS}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8} className="z-50">
          <Menu.Popup className={POPUP_CLASS}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A fixed slot so checked and unchecked rows keep their text aligned. */
function Tick({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex size-3.5 shrink-0 items-center justify-center">{children}</span>;
}

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
      <Menu.CheckboxItem checked={onlyRequested} onCheckedChange={onOnlyRequestedChange} className={ITEM_CLASS}>
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
            <Menu.GroupLabel className={LABEL_CLASS}>Repositories</Menu.GroupLabel>
            {repos.map((repo) => (
              <Menu.CheckboxItem
                key={repo.id}
                checked={!hiddenRepoIds.has(repo.id)}
                onCheckedChange={(shown) => onRepoToggle(repo.id, shown)}
                className={ITEM_CLASS}
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
        <Menu.GroupLabel className={LABEL_CLASS}>Sort by</Menu.GroupLabel>
        <Menu.RadioGroup value={sort} onValueChange={(value: QueueSort) => onSortChange(value)}>
          {SORT_LABELS.map(({ value, label }) => (
            <Menu.RadioItem key={value} value={value} closeOnClick className={ITEM_CLASS}>
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
