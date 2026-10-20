/**
 * The first-visit flow (see lib/onboarding.ts for when it shows): four
 * steps on a page of their own, over everything, each skippable.
 *
 *  - Welcome: three screenshots of what Joinery is for, cycling on a timer.
 *  - Repositories: the add-repo folder picker, with a heads-up about the
 *    macOS folder prompt until Full Disk Access is granted.
 *  - Tooling: git, Claude Code, `gh` and `glab`, from the settings page's
 *    integrations check, each with the fix when it isn't ready.
 *  - Make it yours: light/dark and the theme, over a mock review window
 *    drawn in the chrome, so a pick visibly re-tints the whole UI.
 */
import type { FullDiskAccess, Integrations } from '@joinery/core';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  FolderGit2,
  FolderPlus,
  Moon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../../lib/apiClient.ts';
import { closeOnboarding, useOnboardingOpen } from '../../lib/onboarding.ts';
import { listThemeOptions } from '../../lib/themes.ts';
import { useHomeData } from '../../state/HomeData.tsx';
import { useTheme, type ChromeMode } from '../../state/ThemeContext.tsx';
import { repoLabel } from '../Explore.tsx';
import { FolderPicker } from '../home/FolderPicker.tsx';
import { Chip, type Tone } from '../home/primitives.tsx';
import { REASON, hostHint } from '../settings/Settings.tsx';
import { ThemePicker } from '../settings/ThemePicker.tsx';
import { MockReview } from './MockReview.tsx';

const STEPS = ['welcome', 'repos', 'tools', 'theme'] as const;
type Step = (typeof STEPS)[number];

const TITLES: Record<Step, string> = {
  welcome: 'Welcome!',
  repos: 'Add your repositories',
  tools: 'Tooling',
  theme: 'Make it yours',
};

/** The header's right-hand slot: a step's controls render there through a portal, so they sit beside the title. */
const ActionsSlot = createContext<HTMLElement | null>(null);

export function Onboarding(): React.JSX.Element | null {
  const open = useOnboardingOpen();
  return open ? <OnboardingFlow /> : null;
}

/** Every step and the footer share one column, so Skip and Next line up under the content. */
const WIDTH = 'w-full max-w-5xl';
/** The footer's buttons, a size up from the toolbar ones. */
const BIG_BTN = 'h-8! px-3.5! text-body!';

function OnboardingFlow(): React.JSX.Element {
  const { chromeMode } = useTheme();
  const [index, setIndex] = useState(0);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const step: Step = STEPS[index] ?? 'welcome';
  const last = index === STEPS.length - 1;

  return (
    // `role="dialog"` makes `keymapGuard` suppress the page's shortcuts underneath.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Joinery"
      className="fixed inset-0 z-40 flex flex-col bg-chrome-bg"
    >
      {/* Where Homebase draws it, so it stays put through every step. The -dark file is the one drawn for dark backgrounds. */}
      <header className="shrink-0 px-4 pt-4">
        <img
          src={chromeMode === 'dark' ? '/joinery-wordmark-squircle-dark.svg' : '/joinery-wordmark-squircle-light.svg'}
          alt="Joinery"
          className="h-[30px] w-auto select-none"
        />
      </header>
      {/* A page of its own rather than a card over one: the step fills it, the footer is pinned under it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className={`mx-auto flex min-h-9 shrink-0 items-center gap-3 px-10 pt-6 ${WIDTH}`}>
          <h2 className="text-2xl font-semibold tracking-tight text-chrome-fg">{TITLES[step]}</h2>
          <div ref={setActions} className="ml-auto flex items-center gap-2" />
        </header>
        <ActionsSlot.Provider value={actions}>
          <div key={step} className={`mx-auto flex min-h-[480px] flex-1 flex-col gap-6 px-10 pt-6 pb-8 ${WIDTH}`}>
            {step === 'welcome' && <WelcomeStep />}
            {step === 'repos' && <ReposStep />}
            {step === 'tools' && <ToolsStep />}
            {step === 'theme' && <ThemeStep />}
          </div>
        </ActionsSlot.Provider>
      </div>
      <div className="shrink-0 border-t border-chrome-border">
        <footer className={`mx-auto grid h-16 grid-cols-[1fr_auto_1fr] items-center px-10 ${WIDTH}`}>
          <div>
            {!last && (
              <button
                type="button"
                onClick={closeOnboarding}
                className="-ml-2.5 h-8 rounded-md px-2.5 text-body font-medium text-chrome-fg-subtle transition-colors hover:bg-chrome-bg-hover hover:text-chrome-fg"
              >
                Skip
              </button>
            )}
          </div>
          <nav aria-label="Steps" className="flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                aria-label={`Step ${String(i + 1)} of ${String(STEPS.length)}`}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => setIndex(i)}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === index ? 'w-4 bg-chrome-fg-muted' : 'w-1.5 bg-chrome-bg-active hover:bg-chrome-border-strong'
                }`}
              />
            ))}
          </nav>
          <div className="flex items-center justify-end gap-1.5">
            {index > 0 && (
              <button type="button" onClick={() => setIndex(index - 1)} className={`chrome-btn ${BIG_BTN}`}>
                <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
                Back
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={() => (last ? closeOnboarding() : setIndex(index + 1))}
              className={`chrome-btn-primary ${BIG_BTN}`}
            >
              {last ? 'Get started' : 'Next'}
              {!last && <ArrowRight size={14} strokeWidth={1.75} aria-hidden />}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** A step's controls, drawn beside the title. */
function StepActions({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const slot = useContext(ActionsSlot);
  return slot !== null ? createPortal(children, slot) : null;
}

/** A server read for a step: null until it answers (or if it fails), re-run by `reload`. */
function useRead<T>(read: () => Promise<T>): { data: T | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    read()
      .then((value) => {
        if (live) setData(value);
      })
      .catch(() => {
        // Nothing to show; the step reads as unknown rather than broken.
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // `read` is a stable module-level call per use site; `tick` re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, reload };
}

// --- Welcome ---

/** How long each screenshot shows before the next. */
const SHOT_MS = 10_000;

/**
 * Screenshots from the seeded demo (scripts/demo), cropped to the part each
 * one is about, in both modes: the shot matches the app's light/dark. Each
 * sentence of `body` gets its own line.
 */
const SHOTS: { title: string; body: string[]; name: string; ext: 'jpg' | 'png' }[] = [
  {
    title: 'Review code in an order\nthat makes sense',
    body: [
      'Go through the files A to Z, or generate a reading order that walks you through the change step by step.',
      'Focus and Skim badges and short notes tell you where to spend your attention.',
    ],
    name: 'review',
    ext: 'jpg',
  },
  {
    title: 'Chat about changes locally',
    body: [
      'Comment on any line to ask for a clarification, a quick answer, or a deep dive into other parts of the codebase.',
      'Claude Code replies in the thread, and nothing is sent upstream.',
    ],
    name: 'thread',
    ext: 'jpg',
  },
  {
    title: 'Keep up with work',
    body: [
      "See every branch and open PR across all your repositories in one dashboard, with what's waiting on you first.",
      'Filters and sorting keep it down to what matters today.',
    ],
    name: 'homebase',
    ext: 'png',
  },
];

function WelcomeStep(): React.JSX.Element {
  const { chromeMode } = useTheme();
  const [shot, setShot] = useState(0);
  const [paused, setPaused] = useState(false);
  // Shots whose file for this mode failed to load; they fall back to the dark one.
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());

  return (
    <>
      <div className="-mt-3 flex max-w-2xl shrink-0 flex-col gap-3 text-[15px] leading-relaxed text-chrome-fg-muted">
        <p>Thanks for taking an interest in this project!</p>
        <p>
          This guide helps you set up the few things Joinery needs, so you can get the most out of it.
          <br />
          Or just skip it altogether, have fun!
        </p>
      </div>
      <div className="flex min-h-0 flex-1 gap-10">
        {/* The features as a vertical list: the selected one opens to its description, so uneven texts never leave gaps in a row. */}
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="What Joinery does"
          className="flex w-80 shrink-0 flex-col justify-center gap-1"
          // Only reading the list holds the timer; looking at the shot doesn't.
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {SHOTS.map((s, i) => {
            const selected = i === shot;
            return (
              <button
                key={s.name}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setShot(i)}
                className={`flex gap-4 rounded-lg py-3 pr-3 pl-0 text-left transition-colors ${
                  selected ? 'text-chrome-fg' : 'text-chrome-fg-muted hover:text-chrome-fg'
                }`}
              >
                {/* The shot's timer: fills downward, then the next one is selected. */}
                <span className="block w-0.5 shrink-0 self-stretch overflow-hidden rounded-full bg-chrome-bg-active">
                  {selected && (
                    <span
                      // Keyed on the shot so the bar restarts whenever it changes, even to the same index.
                      key={shot}
                      className="onboarding-progress block h-full w-full rounded-full bg-chrome-accent"
                      style={{ ['--onboarding-shot-ms' as string]: `${String(SHOT_MS)}ms`, animationPlayState: paused ? 'paused' : 'running' }}
                      onAnimationEnd={() => setShot((shot + 1) % SHOTS.length)}
                    />
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-[15px] font-medium whitespace-pre-line">{s.title}</span>
                  {/* Opens and closes by tweening `grid-template-rows` between 0fr and 1fr: its natural height, without measuring. */}
                  <span
                    aria-hidden={!selected}
                    className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
                      selected ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <span className="flex min-h-0 flex-col gap-2 overflow-hidden text-body leading-relaxed text-chrome-fg-muted">
                      {s.body.map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {/* No frame of its own: the shots stack in one grid cell and each is sized to fit, so the screenshot's edge is the only edge. */}
        <div className="grid min-h-[220px] min-w-0 flex-1 [grid-template:minmax(0,1fr)/minmax(0,1fr)] place-items-center">
          {SHOTS.map((s, i) => (
            <img
              key={s.name}
              src={`/onboarding/${s.name}-${missing.has(s.name) ? 'dark' : chromeMode}.${s.ext}`}
              onError={() => {
                if (chromeMode !== 'dark') setMissing((prev) => new Set(prev).add(s.name));
              }}
              alt={i === shot ? s.title : ''}
              aria-hidden={i !== shot}
              draggable={false}
              className={`max-h-full max-w-full select-none rounded-lg shadow-chrome ring-1 ring-chrome-border transition-opacity duration-500 [grid-area:1/1] ${
                i === shot ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ))}
        </div>
      </div>
    </>
  );
}

// --- Repositories ---

const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab', none: 'No forge' } as const;

function ReposStep(): React.JSX.Element {
  const { repos, refresh } = useHomeData();
  const [adding, setAdding] = useState(false);
  const sorted = useMemo(() => [...repos].sort((a, b) => repoLabel(a).localeCompare(repoLabel(b))), [repos]);
  const fda = useRead<FullDiskAccess>(() => callApi('fullDiskAccess'));
  // The browser runs on the server's machine, so its platform is the server's.
  const mac = /Mac/.test(navigator.userAgent);
  const showPrompt = mac && fda.data?.granted !== true;

  return (
    <>
      <StepActions>
        {sorted.length > 0 && (
          <button type="button" onClick={() => setAdding(true)} className="chrome-btn">
            <Plus size={13} strokeWidth={1.75} aria-hidden />
            Add more
          </button>
        )}
      </StepActions>
      {showPrompt && (
        <p className="flex shrink-0 items-center gap-2 rounded-md bg-chrome-bg-hover px-3 py-2 text-xs text-chrome-fg-muted">
          <ShieldCheck size={14} strokeWidth={1.75} className="shrink-0 text-chrome-fg-subtle" aria-hidden />
          <span>
            For repos in Desktop, Documents, Downloads or iCloud Drive, choose <span className="font-medium text-chrome-fg">Allow</span> when macOS
            asks. It remembers a Don't Allow.
          </span>
        </p>
      )}
      {sorted.length === 0 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-chrome-border-strong text-chrome-fg-muted transition-colors hover:border-chrome-fg-subtle hover:bg-chrome-bg-hover hover:text-chrome-fg"
        >
          <FolderPlus size={22} strokeWidth={1.5} aria-hidden />
          <span className="text-body font-medium">Choose folders</span>
        </button>
      ) : (
        <ul className="flex min-h-0 flex-col overflow-y-auto rounded-lg border border-chrome-border p-1">
          {sorted.map((r) => (
            <Row
              key={r.id}
              icon={<FolderGit2 />}
              title={repoLabel(r)}
              detail={r.remoteHost !== null ? `${r.rootPath} · ${r.remoteHost}` : r.rootPath}
            >
              <Chip>{r.forge === null ? 'Detecting…' : FORGE_LABEL[r.forge]}</Chip>
            </Row>
          ))}
        </ul>
      )}
      {adding && (
        <FolderPicker
          onAdded={() => {
            setAdding(false);
            void refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </>
  );
}

/** One label/value row, as on the settings page. */
function Row({
  icon,
  title,
  detail,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2">
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-chrome-fg-subtle [&>svg]:size-4" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body text-chrome-fg">{title}</span>
        {detail !== undefined && <span className="truncate text-micro text-chrome-fg-subtle">{detail}</span>}
      </span>
      {children !== undefined && <span className="flex shrink-0 items-center gap-1.5">{children}</span>}
    </li>
  );
}

// --- Tooling ---

/**
 * The tool's state. `fix` is the command or step that makes it ready, shown
 * under the row; `info` (where it was found, who it's signed in to) only
 * shows on hover, since a ready tool needs no reading.
 */
interface ToolStatus {
  tone: Tone;
  label: string;
  fix?: string;
  info?: string;
}

function gitStatus(data: Integrations): ToolStatus {
  return data.git.path !== null
    ? { tone: 'success', label: 'Installed', info: data.git.path }
    : { tone: 'danger', label: 'Not installed', fix: 'xcode-select --install, or your package manager' };
}

function claudeStatus(data: Integrations): ToolStatus {
  if (data.claude.path !== null) return { tone: 'success', label: 'Found', info: data.claude.path };
  if (data.claude.bundled) return { tone: 'success', label: 'Found', info: 'Bundled with the Agent SDK' };
  return { tone: 'warning', label: 'Not found', fix: 'Install it, then run claude once to sign in' };
}

/** A forge's CLI: missing, or the first registered host it can't ask, or fine. Only a host in use makes a missing CLI a problem. */
function forgeStatus(data: Integrations, forge: 'github' | 'gitlab'): ToolStatus {
  const cli = forge === 'github' ? 'gh' : 'glab';
  const path = data.clis.find((c) => c.cli === cli)?.path ?? null;
  const hosts = data.hosts.filter((h) => h.forge === forge);
  if (path === null) return { tone: hosts.length > 0 ? 'danger' : 'neutral', label: 'Not installed', fix: `brew install ${cli}` };
  const failing = hosts.find((h) => h.reason !== null);
  if (failing?.reason != null) {
    const { tone, label } = REASON[failing.reason];
    return { tone, label, fix: hostHint(cli, failing.host, failing.reason) ?? failing.host };
  }
  if (hosts.length > 0) return { tone: 'success', label: 'Signed in', info: hosts.map((h) => h.host).join(', ') };
  return { tone: 'success', label: 'Installed', info: path };
}

const TOOLS: { key: string; icon: React.ReactNode; title: string; why: string; status: (d: Integrations) => ToolStatus }[] = [
  { key: 'git', icon: <GitMark />, title: 'Git', why: 'Reads branches, commits and diffs straight from your clones.', status: gitStatus },
  {
    key: 'github',
    icon: <GitHubMark />,
    title: 'GitHub',
    why: 'Lists your pull requests and review requests, through the gh CLI.',
    status: (d) => forgeStatus(d, 'github'),
  },
  {
    key: 'gitlab',
    icon: <GitLabMark />,
    title: 'GitLab',
    why: 'Lists your merge requests, through the glab CLI.',
    status: (d) => forgeStatus(d, 'gitlab'),
  },
  {
    key: 'claude',
    icon: <Bot strokeWidth={1.75} />,
    title: 'Claude Code',
    why: 'Answers your threads and writes reading orders.',
    status: claudeStatus,
  },
];

function ToolsStep(): React.JSX.Element {
  const { data, loading, reload } = useRead(() => callApi('integrations'));

  return (
    <>
      <StepActions>
        <button type="button" onClick={reload} aria-label="Check again" title="Check again" className="chrome-icon-btn">
          <RefreshCw size={14} strokeWidth={1.75} className={loading ? 'animate-spin' : ''} aria-hidden />
        </button>
      </StepActions>
      <ul className={`flex flex-col gap-1 transition-opacity ${loading && data !== null ? 'opacity-60' : ''}`}>
        {TOOLS.map((tool) => {
          const status = data !== null ? tool.status(data) : null;
          return (
            <li key={tool.key} className="flex items-start gap-3.5 rounded-md px-3 py-3" title={status?.info}>
              <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-chrome-fg-muted [&>svg]:size-5" aria-hidden>
                {tool.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium text-chrome-fg">{tool.title}</span>
                <span className="text-xs text-chrome-fg-muted">{tool.why}</span>
                {status?.fix !== undefined && <code className="mt-1 truncate text-micro text-chrome-fg-subtle">{status.fix}</code>}
              </span>
              <span className="mt-0.5 shrink-0">
                {status !== null ? (
                  <Chip tone={status.tone} {...(status.tone === 'success' ? { icon: <Check size={11} strokeWidth={2.5} /> } : {})}>
                    {status.label}
                  </Chip>
                ) : (
                  <Chip>{loading ? 'Checking…' : "Couldn't check"}</Chip>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/*
 * The services' own marks (Simple Icons paths), single-colour in the row's
 * text colour: each names the service it links to, which their brand
 * guidelines allow.
 */

function GitMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.546 10.93 13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187" />
    </svg>
  );
}

function GitHubMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GitLabMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </svg>
  );
}

// --- Make it yours ---

function ThemeStep(): React.JSX.Element {
  const { chromeMode, setChromeMode, diffTheme, setDiffTheme } = useTheme();
  const options = useMemo(() => listThemeOptions(), []);
  // The theme highlighted in the open picker: previewed on the mock only;
  // the app's theme changes on a pick.
  const [preview, setPreview] = useState<string | null>(null);

  return (
    <>
      <StepActions>
        {/* Same height, border and fill as the picker beside it. */}
        <div role="tablist" aria-label="Mode" className="flex h-8 items-center gap-0.5 rounded-md border border-chrome-border bg-chrome-bg-raised p-[3px]">
          {(['dark', 'light'] as const).map((mode) => (
            <ModeTab key={mode} mode={mode} selected={chromeMode === mode} onSelect={() => setChromeMode(mode)} />
          ))}
        </div>
        <div className="w-56">
          <ThemePicker
            // Keyed on the mode: the other mode's list is a different set of themes.
            key={chromeMode}
            id="onboarding-theme"
            options={options.filter((o) => o.colorScheme === undefined || o.colorScheme === chromeMode)}
            value={diffTheme[chromeMode]}
            onChange={(name) => setDiffTheme({ ...diffTheme, [chromeMode]: name })}
            onPreview={setPreview}
            onClose={() => setPreview(null)}
          />
        </div>
      </StepActions>
      <MockReview theme={diffTheme[chromeMode]} preview={preview} />
    </>
  );
}

function ModeTab({ mode, selected, onSelect }: { mode: ChromeMode; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const Icon = mode === 'dark' ? Moon : Sun;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex h-full items-center gap-1.5 rounded-[4px] px-2.5 text-xs font-medium transition-colors ${
        selected ? 'bg-chrome-bg-active text-chrome-fg' : 'text-chrome-fg-muted hover:bg-chrome-bg-hover hover:text-chrome-fg'
      }`}
    >
      <Icon size={13} strokeWidth={1.75} aria-hidden />
      {mode === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}
