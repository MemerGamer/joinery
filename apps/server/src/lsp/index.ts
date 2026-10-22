/**
 * Hover, definition, uses and file contents for the review UI's code
 * intelligence, served by real language servers running against the
 * review's checkout.
 *
 * One server per (language, checkout), started lazily on the first request,
 * stopped after `IDLE_MS` without one, and at most `MAX_SESSIONS` alive at
 * once (least recently used goes first). A server that is missing or failed
 * to start is remembered for `RETRY_MS`, so hovering doesn't re-probe PATH
 * on every token, yet installing one is picked up without a restart.
 *
 * Servers run in the review's own checkout when its branch is checked out,
 * else in a checkout of its current commit (`views.ts`, `checkouts.ts`), so
 * other files resolve as the review has them. The file being hovered is
 * also sent as an open document holding the *review's* text for it (the
 * head side of the current revision), keyed by its blob SHA: on a checked
 * out branch that covers `head`/`pr` differing from the disk, and anywhere
 * it answers right while a checkout is still moving.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LspDefinition, LspFile, LspHover, LspLanguage, LspReference, LspReferences } from '@joinery/core';
import { isCancelled, LspClient } from './client.ts';
import { languageOf, resolveServer, type ServerSpec } from './servers.ts';

export { installedServers, languageOf } from './servers.ts';
export { installServer, startLspUpdates } from './install.ts';

const IDLE_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const MAX_SESSIONS = 4;
const MAX_OPEN_DOCUMENTS = 24;
/** Past this, a file is shown only up to a little after the line asked for (generated files, bundles). */
const FILE_MAX_CHARS = 1_000_000;
const FILE_LINES_AFTER_WHEN_CUT = 200;
const MAX_REFERENCES = 1_000;
const PREVIEW_MAX_CHARS = 200;
const MAX_EXTERNALS = 5_000;

type OpenDocument = { key: string; version: number; text: string; ready: Promise<void> };

type Session = {
  readonly key: string;
  readonly root: string;
  spec: ServerSpec | null;
  client: Promise<LspClient | null>;
  /** When `client` resolved to null: retried after `RETRY_MS`. */
  failedAt: number | null;
  lastUsed: number;
  readonly docs: Map<string, OpenDocument>;
};

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };

/** A file to ask about, with the text the review has for it. */
export type LspSource = {
  /** The checkout the server runs in (`views.ts`). */
  readonly root: string;
  /** Absolute path of the file. */
  readonly file: string;
  /** Identity of the text `loadText` returns: a blob SHA, or the disk copy's mtime and size. */
  readonly contentKey: string;
  readonly loadText: () => Promise<string | null>;
};

export type LspTarget = LspSource & {
  /** 1-based line, 0-based UTF-16 character. */
  readonly line: number;
  readonly character: number;
  readonly signal?: AbortSignal;
};

/**
 * Files outside the checkout that a server pointed to, by the id in their
 * `external:<id>` ref: only these can be read back through a ref.
 */
const externals = new Map<string, string>();

function externalRef(file: string): string {
  const id = createHash('sha1').update(file).digest('hex').slice(0, 16);
  externals.delete(id);
  externals.set(id, file);
  if (externals.size > MAX_EXTERNALS) externals.delete(externals.keys().next().value as string);
  return `external:${id}`;
}

/** The absolute path behind an `external:<id>` ref; null for an unknown id or a ref of another kind. */
export function externalFile(ref: string): string | null {
  return ref.startsWith('external:') ? (externals.get(ref.slice('external:'.length)) ?? null) : null;
}

/** How a file is named to the client: by repo path inside `root`, else by an external ref. */
function describe(root: string, file: string, inReview: (path: string) => boolean) {
  const rel = relative(root, file);
  const external = rel.startsWith('..') || isAbsolute(rel);
  if (!external) {
    const path = rel.split(sep).join('/');
    return { ref: path, path, external, inReview: inReview(path) };
  }
  const home = homedir();
  return {
    ref: externalRef(file),
    path: file.startsWith(home + sep) ? `~${file.slice(home.length)}` : file,
    external,
    inReview: false,
  };
}

/** `text`, cut short when huge: up to a little after `line` (0-based) when there is one, else what fits. */
function shown(text: string, line?: number): { text: string; truncated: boolean } {
  if (text.length <= FILE_MAX_CHARS) return { text, truncated: false };
  if (line !== undefined) {
    return { text: text.split(/\r?\n/).slice(0, line + FILE_LINES_AFTER_WHEN_CUT).join('\n'), truncated: true };
  }
  return { text: text.slice(0, Math.max(0, text.lastIndexOf('\n', FILE_MAX_CHARS))), truncated: true };
}

class LspManager {
  readonly #sessions = new Map<string, Session>();
  #sweep: ReturnType<typeof setInterval> | null = null;

  async hover(target: LspTarget): Promise<LspHover | null> {
    const prepared = await this.#prepare(target);
    if (prepared === null) return null;
    const { client, spec, uri } = prepared;
    try {
      const result = await client.request<{ contents?: unknown } | null>(
        'textDocument/hover',
        { textDocument: { uri }, position: { line: target.line - 1, character: target.character } },
        target.signal,
      );
      const markdown = hoverMarkdown(result?.contents);
      return markdown === null ? null : { markdown, server: spec.id };
    } catch (err) {
      if (isCancelled(err)) return null;
      throw err;
    }
  }

  async definition(target: LspTarget, inReview: (path: string) => boolean): Promise<LspDefinition | null> {
    const prepared = await this.#prepare(target);
    if (prepared === null) return null;
    const { client, spec, uri, session } = prepared;
    let result: unknown;
    try {
      result = await client.request(
        'textDocument/definition',
        { textDocument: { uri }, position: { line: target.line - 1, character: target.character } },
        target.signal,
      );
    } catch (err) {
      if (isCancelled(err)) return null;
      throw err;
    }
    const location = firstLocation(result);
    if (location === null || !location.uri.startsWith('file:')) return null;

    const file = fileURLToPath(location.uri);
    const text = session.docs.get(location.uri)?.text ?? (await readFile(file, 'utf8').catch(() => null));
    if (text === null) return null;
    const focus = Math.min(location.focus.line, Math.max(0, text.split(/\r?\n/).length - 1));
    return {
      ...describe(session.root, file, inReview),
      ...shown(text, focus),
      line: focus + 1,
      server: spec.id,
    };
  }

  /** Every use of the symbol at `target` (its declaration aside), with each line's text. */
  async references(target: LspTarget, inReview: (path: string) => boolean): Promise<LspReferences | null> {
    const prepared = await this.#prepare(target);
    if (prepared === null) return null;
    const { client, spec, uri, session } = prepared;
    let result: { uri?: string; range?: Range }[] | null;
    try {
      result = await client.request(
        'textDocument/references',
        {
          textDocument: { uri },
          position: { line: target.line - 1, character: target.character },
          context: { includeDeclaration: false },
        },
        target.signal,
      );
    } catch (err) {
      if (isCancelled(err)) return null;
      throw err;
    }
    const lines = new Map<string, Promise<string[] | null>>();
    const linesOf = (fileUri: string) => {
      let pending = lines.get(fileUri);
      if (pending === undefined) {
        const open = session.docs.get(fileUri)?.text;
        pending =
          open !== undefined
            ? Promise.resolve(open.split(/\r?\n/))
            : readFile(fileURLToPath(fileUri), 'utf8').then((t) => t.split(/\r?\n/), () => null);
        lines.set(fileUri, pending);
      }
      return pending;
    };
    const found = (result ?? []).filter(
      (r): r is { uri: string; range: Range } => typeof r.uri === 'string' && r.uri.startsWith('file:') && r.range !== undefined,
    );
    const references = await Promise.all(
      found.map(async (r): Promise<LspReference> => {
        const line = (await linesOf(r.uri))?.[r.range.start.line] ?? '';
        return {
          ...describe(session.root, fileURLToPath(r.uri), inReview),
          line: r.range.start.line + 1,
          character: r.range.start.character,
          preview: line.trim().slice(0, PREVIEW_MAX_CHARS),
        };
      }),
    );
    references.sort(
      (a, b) =>
        Number(b.inReview) - Number(a.inReview) ||
        Number(a.external) - Number(b.external) ||
        a.path.localeCompare(b.path) ||
        a.line - b.line ||
        a.character - b.character,
    );
    return {
      references: references.slice(0, MAX_REFERENCES),
      truncated: references.length > MAX_REFERENCES,
      server: spec.id,
    };
  }

  /** A file to show, as the review has it; no server needed. */
  async file(source: LspSource, inReview: (path: string) => boolean): Promise<LspFile | null> {
    const text = await source.loadText();
    return text === null ? null : { ...describe(source.root, source.file, inReview), ...shown(text) };
  }

  /**
   * Forget every session for `language`, running or remembered as missing,
   * so the next hover picks a server again (after an install or removal).
   */
  async reset(language: LspLanguage): Promise<void> {
    const prefix = `${language}\0`;
    await Promise.all(
      Array.from(this.#sessions.values())
        .filter((s) => s.key.startsWith(prefix))
        .map((s) => this.#stop(s)),
    );
  }

  /** Every server running in `root` stopped, before its checkout moves or goes. */
  async stopRoot(root: string): Promise<void> {
    await Promise.all(
      Array.from(this.#sessions.values())
        .filter((s) => s.root === root)
        .map((s) => this.#stop(s)),
    );
  }

  /** Start `languages`' servers in `root` ahead of the first hover; missing ones are just skipped. */
  async warm(root: string, languages: Iterable<LspLanguage>): Promise<void> {
    await Promise.all(Array.from(new Set(languages), async (language) => (await this.#session(language, root)).client));
  }

  /** Every running server, stopped; for shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.#sessions.values(), (s) => this.#stop(s)));
  }

  async #prepare(
    target: LspTarget,
  ): Promise<{ client: LspClient; spec: ServerSpec; uri: string; session: Session } | null> {
    const lang = languageOf(target.file);
    if (lang === null) return null;
    const session = await this.#session(lang.language, target.root);
    const client = await session.client;
    if (client === null || session.spec === null || target.signal?.aborted === true) return null;
    const uri = pathToFileURL(target.file).href;
    const opened = await this.#ensureDocument(session, client, uri, lang.languageId, target);
    return opened ? { client, spec: session.spec, uri, session } : null;
  }

  async #session(language: LspLanguage, root: string): Promise<Session> {
    const key = `${language}\0${root}`;
    const existing = this.#sessions.get(key);
    const now = Date.now();
    if (existing !== undefined && (existing.failedAt === null || now - existing.failedAt < RETRY_MS)) {
      existing.lastUsed = now;
      return existing;
    }
    if (existing !== undefined) this.#sessions.delete(key);

    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = Array.from(this.#sessions.values()).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest === undefined) break;
      void this.#stop(oldest);
    }

    const session: Session = {
      key,
      root,
      spec: null,
      client: Promise.resolve(null),
      failedAt: null,
      lastUsed: now,
      docs: new Map(),
    };
    session.client = this.#start(session, language);
    this.#sessions.set(key, session);
    this.#sweep ??= setInterval(() => this.#stopIdle(), 60_000);
    this.#sweep.unref?.();
    return session;
  }

  async #start(session: Session, language: LspLanguage): Promise<LspClient | null> {
    const spec = await resolveServer(language, session.root);
    session.spec = spec;
    if (spec === null) {
      session.failedAt = Date.now();
      return null;
    }
    const started = Date.now();
    try {
      const client = await LspClient.start({
        command: spec.command,
        root: session.root,
        initializationOptions: spec.initializationOptions,
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        onExit: (code) => {
          // A crash drops the session so the next hover starts a fresh one.
          if (this.#sessions.get(session.key) === session) this.#sessions.delete(session.key);
          if (code !== 0 && code !== null) console.log(`[lsp] ${spec.id} in ${session.root} exited with ${code}`);
        },
      });
      console.log(`[lsp] started ${spec.id} for ${session.root} in ${Date.now() - started} ms`);
      return client;
    } catch (err) {
      console.log(`[lsp] could not start ${spec.id}: ${err instanceof Error ? err.message : String(err)}`);
      session.failedAt = Date.now();
      return null;
    }
  }

  /**
   * Opens `uri` with the review's text, or brings an open copy up to date.
   * Concurrent hovers on one file share the same open; the least recently
   * opened documents are closed past `MAX_OPEN_DOCUMENTS` (the server then
   * falls back to the disk copy, which is what it would use anyway).
   */
  async #ensureDocument(
    session: Session,
    client: LspClient,
    uri: string,
    languageId: string,
    target: LspTarget,
  ): Promise<boolean> {
    const doc = session.docs.get(uri);
    if (doc !== undefined && doc.key === target.contentKey) {
      // Re-insert to mark as most recently used.
      session.docs.delete(uri);
      session.docs.set(uri, doc);
      await doc.ready;
      return true;
    }
    const next: OpenDocument = { key: target.contentKey, version: (doc?.version ?? 0) + 1, text: '', ready: Promise.resolve() };
    let loaded = true;
    next.ready = (async () => {
      const text = await target.loadText().catch((err: unknown) => {
        session.docs.delete(uri);
        throw err;
      });
      if (text === null) {
        loaded = false;
        session.docs.delete(uri);
        return;
      }
      next.text = text;
      if (doc === undefined) {
        client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: next.version, text } });
      } else {
        client.notify('textDocument/didChange', {
          textDocument: { uri, version: next.version },
          contentChanges: [{ text }],
        });
      }
    })();
    session.docs.delete(uri);
    session.docs.set(uri, next);
    for (const [oldUri] of session.docs) {
      if (session.docs.size <= MAX_OPEN_DOCUMENTS) break;
      session.docs.delete(oldUri);
      client.notify('textDocument/didClose', { textDocument: { uri: oldUri } });
    }
    await next.ready;
    return loaded;
  }

  #stopIdle(): void {
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      if (now - session.lastUsed > IDLE_MS) void this.#stop(session);
    }
    if (this.#sessions.size === 0 && this.#sweep !== null) {
      clearInterval(this.#sweep);
      this.#sweep = null;
    }
  }

  async #stop(session: Session): Promise<void> {
    if (this.#sessions.get(session.key) === session) this.#sessions.delete(session.key);
    const client = await session.client.catch(() => null);
    await client?.stop();
  }
}

export const lsp = new LspManager();

/** `MarkupContent`, a `MarkedString`, or an array of them, as one markdown string; null when empty. */
function hoverMarkdown(contents: unknown): string | null {
  const parts = (Array.isArray(contents) ? contents : [contents])
    .map((part): string => {
      if (typeof part === 'string') return part;
      if (part === null || typeof part !== 'object') return '';
      const { kind, language, value } = part as { kind?: string; language?: string; value?: string };
      if (typeof value !== 'string') return '';
      if (language !== undefined) return '```' + language + '\n' + value + '\n```';
      // Plain text isn't markdown: fence it so it renders verbatim.
      if (kind === 'plaintext') return '```text\n' + value + '\n```';
      return value;
    })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? null : parts.join('\n\n');
}

/**
 * The first `Location` or `LocationLink`. `focus` is where the name is (a
 * link's selection range, else the location's own range).
 */
function firstLocation(result: unknown): { uri: string; focus: Position } | null {
  const first = Array.isArray(result) ? result[0] : result;
  if (first === null || typeof first !== 'object') return null;
  const loc = first as {
    uri?: string;
    range?: Range;
    targetUri?: string;
    targetRange?: Range;
    targetSelectionRange?: Range;
  };
  if (typeof loc.targetUri === 'string' && loc.targetRange !== undefined) {
    return { uri: loc.targetUri, focus: (loc.targetSelectionRange ?? loc.targetRange).start };
  }
  if (typeof loc.uri === 'string' && loc.range !== undefined) {
    return { uri: loc.uri, focus: loc.range.start };
  }
  return null;
}
