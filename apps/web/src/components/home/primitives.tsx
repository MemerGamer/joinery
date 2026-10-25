/**
 * Small presentational pieces shared by Homebase and Explore: avatars,
 * chips, progress, diff stats. Kept dumb — they render props and nothing
 * else — so the two screens can differ in layout while sharing a vocabulary.
 */
import { Bot, CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Ci, Person } from '../../lib/people.ts';
import { Hint } from '../controls.tsx';

export function Avatar({ person, size = 24 }: { person: Person; size?: number }): React.JSX.Element {
  return (
    <Hint label={person.name}>
      <span
        role="img"
        aria-label={person.name}
        className="home-avatar shrink-0"
        style={{ ['--h' as string]: person.hue, width: size, height: size, fontSize: Math.round(size * 0.38) }}
      >
        {person.agent === true ? <Bot size={Math.round(size * 0.55)} strokeWidth={2} aria-hidden /> : person.initials}
      </span>
    </Hint>
  );
}

export type Tone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success';

const TONE: Record<Tone, string> = {
  neutral: 'bg-chrome-bg-hover text-chrome-fg-muted',
  accent: 'bg-chrome-accent-soft text-chrome-accent',
  warning: 'bg-chrome-warning-bg text-chrome-warning',
  danger: 'bg-chrome-danger-bg text-chrome-danger',
  success: 'bg-chrome-success-bg text-chrome-success',
};

export function Chip({
  tone = 'neutral',
  icon,
  children,
  title,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <Hint label={title}>
      <span
        className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro font-medium whitespace-nowrap tabular-nums ${TONE[tone]}`}
      >
        {icon}
        {children}
      </span>
    </Hint>
  );
}

export function ProgressBar({ value, total }: { value: number; total: number }): React.JSX.Element {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  const done = total > 0 && value >= total;
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      className="block h-1.5 w-full overflow-hidden rounded-full bg-chrome-bg-active"
    >
      <span
        className={`block h-full rounded-full transition-[width] ${done ? 'bg-chrome-success' : 'bg-chrome-accent'}`}
        style={{ width: `${String(pct)}%` }}
      />
    </span>
  );
}

/** GitHub-style "+412 −88" with a tiny five-block bar. */
export function DiffStat({
  additions,
  deletions,
  blocks: showBlocks = true,
}: {
  additions: number;
  deletions: number;
  /** The five-square add/delete ratio after the counts. */
  blocks?: boolean;
}): React.JSX.Element {
  const total = additions + deletions;
  const blocks = 5;
  const add = total === 0 ? 0 : Math.round((additions / total) * blocks);
  return (
    <Hint label={`${String(additions)} additions, ${String(deletions)} deletions`}>
      <span className="inline-flex items-center gap-1.5 text-micro tabular-nums whitespace-nowrap">
        <span className="text-chrome-success">+{additions.toLocaleString()}</span>
        <span className="text-chrome-danger">−{deletions.toLocaleString()}</span>
        {showBlocks && (
          <span className="inline-flex gap-px" aria-hidden>
            {Array.from({ length: blocks }, (_, i) => (
              <span
                key={i}
                className={`size-1.5 rounded-[1px] ${i < add ? 'bg-chrome-success' : i < blocks && total > 0 ? 'bg-chrome-danger' : 'bg-chrome-bg-active'}`}
              />
            ))}
          </span>
        )}
      </span>
    </Hint>
  );
}

export function CiIcon({ ci, size = 13 }: { ci: Ci; size?: number }): React.JSX.Element | null {
  if (ci === null) return null;
  if (ci === 'passing') return <CircleCheck size={size} strokeWidth={2} className="shrink-0 text-chrome-success" aria-label="CI passing" />;
  if (ci === 'failing') return <CircleX size={size} strokeWidth={2} className="shrink-0 text-chrome-danger" aria-label="CI failing" />;
  return <CircleDashed size={size} strokeWidth={2} className="shrink-0 animate-[spin_3s_linear_infinite] text-chrome-warning" aria-label="CI running" />;
}

export function SectionHeading({
  title,
  count,
  hint,
  action,
}: {
  title: string;
  count?: number;
  hint?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-body font-semibold text-chrome-fg">{title}</h2>
      {count !== undefined && <span className="text-xs tabular-nums text-chrome-fg-subtle">{count}</span>}
      {hint !== undefined && <span className="text-xs text-chrome-fg-subtle">· {hint}</span>}
      <div className="flex-1" />
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-chrome-bg-hover px-1 font-sans text-micro text-chrome-fg-muted">
      {children}
    </kbd>
  );
}

/** "3m", "2h", "4d" — for elapsed durations, where "ago" would be noise. */
export function elapsed(sinceUnix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sinceUnix);
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m`;
  if (s < 86400) return `${String(Math.floor(s / 3600))}h`;
  return `${String(Math.floor(s / 86400))}d`;
}

/** Four rising bars, filled to the level — a signal-strength glyph for "how much of me will this take". */
export function EffortMeter({ level, label, minutes }: { level: 1 | 2 | 3 | 4; label: string; minutes: number }): React.JSX.Element {
  const tone = ['text-chrome-success', 'text-chrome-accent', 'text-chrome-warning', 'text-chrome-danger'][level - 1];
  return (
    <Hint label={`${label} · about ${String(minutes)} minutes`}>
      <span className="inline-flex items-end gap-1.5 text-micro leading-none whitespace-nowrap">
        <span className="tabular-nums text-chrome-fg-muted">{minutes}m</span>
        <span className={`inline-flex items-end gap-px ${tone ?? ''}`} aria-hidden>
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`w-1 rounded-[1px] ${i <= level ? 'bg-current' : 'bg-chrome-bg-active'}`}
              style={{ height: 3 + i * 2.5 }}
            />
          ))}
        </span>
      </span>
    </Hint>
  );
}
