/**
 * Choosing a language's server for hover and peek, shared by Settings →
 * Integrations and onboarding's tooling step: on (the default server, tsrs
 * or PHPantom, which Joinery downloads into its data directory and keeps up
 * to date), a binary at a custom path, or off — the default, since turning
 * it on downloads a server.
 *
 * `useLanguageServerPicker` holds the choosing; each place lays out its
 * `controls` (Turn on while off, the menu, Retry when an install failed),
 * `detail` (what runs, or what's wrong) and `editor` (the custom path form,
 * while open) its way.
 */
import { LSP_DEFAULT_SERVER, LSP_SERVERS, type Integrations, type LspChoice, type LspServerId } from '@joinery/core';
import { useState } from 'react';
import { ApiError, callApi } from '../../lib/apiClient.ts';
import { ChromeSelect, type ChromeSelectOption } from './ChromeSelect.tsx';

type LspRow = Integrations['lsp'][number];

export const LSP_TITLE: Record<LspRow['language'], { title: string; files: string }> = {
  typescript: { title: 'TypeScript language server', files: 'TypeScript and JavaScript' },
  php: { title: 'PHP language server', files: 'PHP' },
};

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

  // Picking the default installs it first (the server does, before saving).
  const save = (choice: LspChoice) =>
    act(choice.source === 'managed' && managed === null ? 'install' : 'save', () =>
      callApi('setLanguageServerChoice', { params: [row.language], body: choice }),
    );

  const pick = async (value: LspChoice['source']) => {
    if (value === 'custom') {
      setEditing(true);
      return;
    }
    setEditing(false);
    await save({ source: value });
  };

  const value = editing ? 'custom' : row.choice.source;
  const options: ChromeSelectOption<LspChoice['source']>[] = [
    ...(installable !== null ? [{ value: 'managed' as const, label: 'On' }] : []),
    { value: 'custom', label: 'Custom path…' },
    { value: 'off', label: 'Off' },
  ];
  // An install that failed (offline at first need, say) is retried here.
  const retry = row.choice.source === 'managed' && installable !== null && managed === null && !row.installing;

  const controls = (
    <>
      {retry && error !== null && (
        <button
          type="button"
          onClick={() => void act('install', () => callApi('installLanguageServer', { params: [installable] }))}
          disabled={busy !== null}
          className="chrome-btn h-8!"
        >
          Retry
        </button>
      )}
      {row.choice.source === 'off' && !editing && installable !== null && (
        <button
          type="button"
          onClick={() => void pick('managed')}
          disabled={busy !== null}
          title={`Downloads ${defaultName} into Joinery's data folder`}
          className="chrome-btn-primary h-8!"
        >
          {busy !== null ? 'Turning on…' : 'Turn on'}
        </button>
      )}
      <ChromeSelect
        value={value}
        options={options}
        onChange={(next) => void pick(next)}
        disabled={busy !== null}
        label={`${LSP_TITLE[row.language].title} to use`}
        className="w-36"
      />
    </>
  );

  const detailText =
    busy === 'install' || row.installing
      ? `Installing ${defaultName}…`
      : (error ??
        row.problem ??
        (row.choice.source === 'off'
          ? installable === null
            ? `No ${defaultName} build for this machine: set a custom path to use another server`
            : `Off · turning it on downloads ${defaultName} into Joinery's data folder`
          : row.choice.source === 'custom'
            ? `${SERVER_NAME[row.choice.server]} · ${row.choice.path}`
            : managed !== null
              ? `On · ${defaultName} ${managed.version} in Joinery's data folder, kept up to date`
              : `On · ${defaultName} will be downloaded into Joinery's data folder`));
  const detail = error !== null || row.problem !== null ? <span className="text-chrome-danger">{detailText}</span> : detailText;

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
      <input
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
