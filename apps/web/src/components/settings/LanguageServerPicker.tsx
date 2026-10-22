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
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { ApiError, callApi } from '../../lib/apiClient.ts';

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

  const controls = (
    <>
      <span className="relative inline-flex">
        <select
          value={value}
          onChange={(e) => void pick(e.target.value)}
          disabled={busy !== null}
          aria-label={`${LSP_TITLE[row.language].title} to use`}
          className="chrome-btn max-w-60 appearance-none truncate pr-7"
        >
          <option value="auto">Automatic</option>
          {local.map((server) => (
            <option key={server} value={`local:${server}`}>
              {SERVER_NAME[server]} on this machine
            </option>
          ))}
          {installable !== null && (
            <option value={`managed:${installable}`}>
              {managed !== null ? `Joinery’s ${SERVER_NAME[installable]} ${managed.version}` : `Install ${SERVER_NAME[installable]} into Joinery`}
            </option>
          )}
          <option value="custom">Custom path…</option>
          <option value="off">Off</option>
        </select>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-chrome-fg-subtle"
          aria-hidden
        />
      </span>
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
      <span className="relative inline-flex shrink-0">
        <select
          value={custom.server}
          onChange={(e) => {
            setCustom((c) => ({ ...c, server: e.target.value as LspServerId }));
            setEditing(true);
          }}
          aria-label="Which server it is"
          title="Which server it is, so Joinery starts it the right way"
          className="chrome-btn appearance-none pr-7"
        >
          {LSP_SERVERS[row.language].map((server) => (
            <option key={server} value={server}>
              {SERVER_NAME[server]}
            </option>
          ))}
        </select>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-chrome-fg-subtle"
          aria-hidden
        />
      </span>
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
        className="h-[26px] min-w-0 flex-1 rounded-md bg-chrome-bg-hover px-2.5 font-mono text-xs text-chrome-fg outline-hidden placeholder:text-chrome-fg-subtle focus:ring-1 focus:ring-chrome-accent"
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
