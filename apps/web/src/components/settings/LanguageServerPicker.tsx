/**
 * Choosing a language's server for hover and peek, shared by Settings →
 * Integrations and onboarding's tooling step: automatic, one found on this
 * machine, the copy Joinery installs into its data directory (picking it
 * installs it first), a binary at a custom path, or off.
 *
 * `useLanguageServerPicker` holds the choosing; each place lays out its
 * `controls` (the menu, and Remove for Joinery's copy), `detail` (what runs,
 * or what's wrong) and `editor` (the custom path form, while open) its way.
 */
import { LSP_SERVERS, type Integrations, type LspChoice, type LspServerId } from '@joinery/core';
import { useState } from 'react';
import { ApiError, callApi } from '../../lib/apiClient.ts';
import { ChromeSelect, type ChromeSelectOption } from './ChromeSelect.tsx';

type LspRow = Integrations['lsp'][number];

export const LSP_TITLE: Record<LspRow['language'], { title: string; files: string; install: string }> = {
  typescript: {
    title: 'TypeScript language server',
    files: 'TypeScript and JavaScript',
    install: 'npm i -g tsrs, or a repo’s own typescript@7',
  },
  php: { title: 'PHP language server', files: 'PHP', install: 'brew install phpantom-lsp' },
};

export const SERVER_NAME: Record<LspServerId, string> = {
  tsrs: 'tsrs',
  tsgo: 'tsgo',
  'typescript-language-server': 'typescript-language-server',
  phpantom: 'PHPantom',
  intelephense: 'Intelephense',
  phpactor: 'Phpactor',
};

/** A choice as a menu value: `auto`, `off`, `custom`, `local:<server>`, `managed:<server>`. */
function valueOf(choice: LspChoice): string {
  return choice.source === 'local' || choice.source === 'managed' ? `${choice.source}:${choice.server}` : choice.source;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export function useLanguageServerPicker(
  row: LspRow,
  onChanged: () => void,
): { controls: React.ReactNode; detail: React.ReactNode; editor: React.ReactNode } {
  const [busy, setBusy] = useState<'save' | 'install' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The custom form: open while picking it, or to change a saved custom path.
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState<{ server: LspServerId; path: string }>(() =>
    row.choice.source === 'custom'
      ? { server: row.choice.server, path: row.choice.path }
      : { server: LSP_SERVERS[row.language][0] ?? 'tsrs', path: '' },
  );
  const { installable, managed } = row;

  const act = async (kind: 'save' | 'install' | 'remove', work: () => Promise<unknown>): Promise<boolean> => {
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

  const save = (choice: LspChoice) =>
    act('save', () => callApi('setLanguageServerChoice', { params: [row.language], body: choice }));

  const pick = async (value: string) => {
    if (value === 'custom') {
      setEditing(true);
      return;
    }
    setEditing(false);
    if (value === 'auto' || value === 'off') {
      await save({ source: value });
      return;
    }
    const [source, server] = value.split(':') as ['local' | 'managed', LspServerId];
    if (source === 'managed' && installable !== null) {
      // Joinery's copy is installed on first pick.
      if (managed === null) {
        const installed = await act('install', () => callApi('installLanguageServer', { params: [installable] }));
        if (!installed) return;
      }
      await save({ source: 'managed', server: installable });
      return;
    }
    await save({ source: 'local', server });
  };

  // Every option the menu offers, the saved choice always among them.
  const local = row.local.map((l) => l.server);
  if (row.choice.source === 'local' && !local.includes(row.choice.server)) local.push(row.choice.server);
  const value = editing ? 'custom' : valueOf(row.choice);
  const options: ChromeSelectOption<string>[] = [
    { value: 'auto', label: 'Automatic' },
    ...local.map((server) => ({ value: `local:${server}`, label: `${SERVER_NAME[server]} on this machine` })),
    ...(installable === null
      ? []
      : [
          {
            value: `managed:${installable}`,
            label:
              managed !== null
                ? `Joinery’s ${SERVER_NAME[installable]} ${managed.version}`
                : `Install ${SERVER_NAME[installable]} into Joinery`,
          },
        ]),
    { value: 'custom', label: 'Custom path…' },
    { value: 'off', label: 'Off' },
  ];

  const controls = (
    <>
      <ChromeSelect
        value={value}
        options={options}
        onChange={(next) => void pick(next)}
        disabled={busy !== null}
        label={`${LSP_TITLE[row.language].title} to use`}
        className="max-w-64"
      />
      {managed !== null && (
        <button
          type="button"
          onClick={() =>
            void act('remove', async () => {
              // Removing the copy in use falls back to choosing automatically.
              if (row.choice.source === 'managed') await callApi('setLanguageServerChoice', { params: [row.language], body: { source: 'auto' } });
              await callApi('removeLanguageServer', { params: [managed.server] });
            })
          }
          disabled={busy !== null}
          title={`Delete Joinery's copy of ${SERVER_NAME[managed.server]} ${managed.version}`}
          className="chrome-btn"
        >
          {busy === 'remove' ? 'Removing…' : 'Remove'}
        </button>
      )}
    </>
  );

  const label = LSP_TITLE[row.language];
  const detailText =
    busy === 'install'
      ? `Installing ${installable !== null ? SERVER_NAME[installable] : ''}…`
      : (error ??
        row.problem ??
        (row.choice.source === 'off'
          ? `Off: no hover or peek in ${label.files} files`
          : row.server === null || row.path === null
            ? `Nothing installed: ${installable !== null ? `pick Install ${SERVER_NAME[installable]}, or ` : ''}${label.install}`
            : `${row.choice.source === 'auto' ? 'Automatic: ' : ''}${SERVER_NAME[row.server]}${row.source === 'managed' && managed !== null ? ` ${managed.version}, installed by Joinery` : ''} · ${row.path}`));
  const detail =
    error !== null || (row.problem !== null && busy === null) ? <span className="text-chrome-danger">{detailText}</span> : detailText;

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
