/**
 * Choosing a language's server for hover and peek, shared by Settings →
 * Integrations and onboarding's tooling step. One switch: on is the default
 * server (tsrs, PHPantom), which Joinery downloads into its data directory
 * and keeps up to date; off — the default, since turning it on downloads a
 * server — is none. "Use your own" in the description opens a form for a
 * binary at a custom path instead.
 *
 * `useLanguageServerPicker` holds the choosing; each place lays out its
 * `controls` (the switch, and Retry when an install failed), `detail` (what
 * runs, or what's wrong, with those links) and `editor` (the custom path
 * form, while open) its way.
 */
import { Input } from '@base-ui-components/react/input';
import { Switch } from '@base-ui-components/react/switch';
import { LSP_DEFAULT_SERVER, LSP_SERVERS, type Integrations, type LspChoice, type LspServerId } from '@joinery/core';
import { useState } from 'react';
import { ApiError, callApi } from '../../lib/apiClient.ts';
import { ChromeSelect } from './ChromeSelect.tsx';

type LspRow = Integrations['lsp'][number];

export const LSP_TITLE: Record<LspRow['language'], { title: string; files: string }> = {
  typescript: { title: 'TypeScript language server', files: 'TypeScript and JavaScript' },
  php: { title: 'PHP language server', files: 'PHP' },
};

export const SWITCH_ROOT_CLASS =
  'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-chrome-bg-active p-0.5 transition-colors data-checked:bg-chrome-accent data-disabled:cursor-default data-disabled:opacity-60';
export const SWITCH_THUMB_CLASS =
  'size-3.5 rounded-full bg-chrome-fg shadow-sm transition-transform data-checked:translate-x-3.5 data-checked:bg-chrome-accent-fg';

export const SERVER_NAME: Record<LspServerId, string> = {
  tsrs: 'tsrs',
  tsgo: 'tsgo',
  'typescript-language-server': 'typescript-language-server',
  phpantom: 'PHPantom',
  intelephense: 'Intelephense',
  phpactor: 'Phpactor',
};

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export function useLanguageServerPicker(
  row: LspRow,
  onChanged: () => void,
): { controls: React.ReactNode; detail: React.ReactNode; editor: React.ReactNode } {
  const [busy, setBusy] = useState<'save' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The custom form: open while picking it, or to change a saved custom path.
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState<{ server: LspServerId; path: string }>(() =>
    row.choice.source === 'custom'
      ? { server: row.choice.server, path: row.choice.path }
      : { server: LSP_SERVERS[row.language][0] ?? 'tsrs', path: '' },
  );
  const { installable, managed } = row;
  const defaultName = SERVER_NAME[LSP_DEFAULT_SERVER[row.language]];

  const act = async (kind: 'save' | 'install', work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    try {
      await work();
      onChanged();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Turning on installs Joinery's copy first (the server does, before saving).
  const save = (choice: LspChoice) =>
    act(choice.source === 'managed' && managed === null ? 'install' : 'save', () =>
      callApi('setLanguageServerChoice', { params: [row.language], body: choice }),
    );

  const canManage = installable !== null;
  // The switch: on is Joinery's copy (or, with no build of it here, a custom server).
  const turn = (on: boolean) => {
    if (on && !canManage) {
      setEditing(true);
      return;
    }
    setEditing(false);
    if (on || row.choice.source !== 'off') void save(on ? { source: 'managed' } : { source: 'off' });
  };
  // An install that failed (offline, say) is retried here.
  const retry = row.choice.source === 'managed' && canManage && managed === null && !row.installing && error !== null;

  const controls = (
    <>
      {retry && (
        <button
          type="button"
          onClick={() => void act('install', () => callApi('installLanguageServer', { params: [installable] }))}
          disabled={busy !== null}
          className="chrome-btn"
        >
          Retry
        </button>
      )}
      <Switch.Root
        checked={row.choice.source !== 'off' || editing}
        onCheckedChange={turn}
        disabled={busy !== null || row.installing}
        aria-label={`${LSP_TITLE[row.language].title}: ${row.choice.source === 'off' ? 'off' : 'on'}`}
        title={row.choice.source === 'off' && canManage ? `Turning it on downloads ${defaultName} into Joinery's data folder` : undefined}
        className={SWITCH_ROOT_CLASS}
      >
        <Switch.Thumb className={SWITCH_THUMB_CLASS} />
      </Switch.Root>
    </>
  );

  const link = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy !== null}
      className="text-chrome-fg-muted underline underline-offset-2 hover:text-chrome-fg"
    >
      {label}
    </button>
  );
  const ownServer = link('use your own', () => setEditing(true));
  const version = managed?.version.split('-')[0] ?? '';

  const detailText: React.ReactNode =
    busy === 'install' || row.installing ? (
      `Downloading ${defaultName} into Joinery's data folder…`
    ) : error !== null || row.problem !== null ? (
      (error ?? row.problem)
    ) : row.choice.source === 'custom' ? (
      <>
        Your own {SERVER_NAME[row.choice.server]}
        {canManage && <> · {link(`use Joinery's ${defaultName}`, () => turn(true))}</>}
      </>
    ) : row.choice.source === 'managed' ? (
      <>
        {managed !== null ? `${defaultName} ${version}, kept up to date` : `${defaultName}, downloading when needed`} · {ownServer}
      </>
    ) : editing ? (
      `Point it at a ${LSP_TITLE[row.language].files} language server you have`
    ) : canManage ? (
      <>
        Turning it on downloads {defaultName} into Joinery's data folder · or {ownServer}
      </>
    ) : (
      <>
        No {defaultName} build for this machine · {ownServer}
      </>
    );
  const detail =
    (error !== null || row.problem !== null) && busy === null ? <span className="text-chrome-danger">{detailText}</span> : detailText;

  const editor = editing || row.choice.source === 'custom' ? (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (custom.path.trim() === '') return;
        void save({ source: 'custom', server: custom.server, path: custom.path.trim() }).then((ok) => ok && setEditing(false));
      }}
      className="flex items-center gap-1.5"
    >
      <ChromeSelect
        value={custom.server}
        options={LSP_SERVERS[row.language].map((server) => ({ value: server, label: SERVER_NAME[server] }))}
        onChange={(server) => {
          setCustom((c) => ({ ...c, server }));
          setEditing(true);
        }}
        label="Which server it is"
        title="Which server it is, so Joinery starts it the right way"
        className="shrink-0"
      />
      <Input
        value={custom.path}
        onChange={(e) => {
          setCustom((c) => ({ ...c, path: e.target.value }));
          setEditing(true);
        }}
        placeholder="/path/to/the/server"
        spellCheck={false}
        autoComplete="off"
        aria-label="Path to the server's binary"
        className="h-8 min-w-0 flex-1 rounded-md border border-chrome-border bg-chrome-bg-raised px-2.5 font-mono text-xs text-chrome-fg outline-hidden transition-colors placeholder:text-chrome-fg-subtle hover:border-chrome-border-strong focus:border-chrome-accent"
      />
      {editing && (
        <button type="submit" disabled={busy !== null || custom.path.trim() === ''} className="chrome-btn">
          {busy === 'save' ? 'Saving…' : 'Use it'}
        </button>
      )}
    </form>
  ) : null;

  return { controls, detail, editor };
}
