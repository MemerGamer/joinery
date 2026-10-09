/**
 * Dashboard card for Homebase: a header (icon, title, count, actions) over a
 * body. The layered hairline and inner top highlight live in the "Homebase
 * panels" block of styles/index.css (`.home-panel`).
 */
import type { ReactNode } from 'react';

export function Panel({
  icon,
  title,
  count,
  urgent = false,
  actions,
  className = '',
  bodyClassName = 'px-1 pb-1.5',
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  count?: number;
  urgent?: boolean;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className={`home-panel relative flex min-h-0 flex-col overflow-hidden rounded-lg border ${className}`}>
      <header className="flex h-9 shrink-0 items-center gap-2 pl-3 pr-1.5">
        {icon !== undefined && (
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-chrome-fg-muted [&>svg]:size-3.5" aria-hidden>
            {icon}
          </span>
        )}
        <h2 className="min-w-0 truncate text-body font-medium text-chrome-fg">{title}</h2>
        {count !== undefined && (
          <span
            className={`rounded-sm px-1 text-micro font-medium tabular-nums ${urgent ? 'bg-chrome-warning-bg text-chrome-warning' : 'bg-chrome-bg-hover text-chrome-fg-muted'}`}
          >
            {count}
          </span>
        )}
        {actions !== undefined && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className={`relative min-h-0 flex-1 overflow-hidden ${bodyClassName}`}>{children}</div>
    </section>
  );
}
