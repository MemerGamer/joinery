/**
 * Hover and peek-definition for the review UI, served by real language
 * servers running against the review's checkout.
 *
 * One server per (language, checkout), started lazily on the first request,
 * stopped after `IDLE_MS` without one, and at most `MAX_SESSIONS` alive at
 * once (least recently used goes first). A server that is missing or failed
 * to start is remembered for `RETRY_MS`, so hovering doesn't re-probe PATH
 * on every token, yet installing one is picked up without a restart.
 *
 * The file being hovered is always sent to the server as an open document
 * holding the *review's* text for it (the head side of the current revision),
 * keyed by its blob SHA. For `working` that equals the disk; for `head`/`pr`
 * it overlays the disk, so positions are exact for whichever revision is on
 * screen. Other files still resolve from disk, which is the known limit when
 * the checkout is not at the revision being reviewed.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LspDefinition, LspHover, LspLanguage } from '@joinery/core';
import { isCancelled, LspClient } from './client.ts';
import { languageOf, resolveServer, type ServerSpec } from './servers.ts';

export { installedServers, languageOf } from './servers.ts';
export { installServer, removeServer } from './install.ts';

const IDLE_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const MAX_SESSIONS = 4;
const MAX_OPEN_DOCUMENTS = 24;
/** Lines of context above the definition's name, and the most shown below it. */
const SNIPPET_BEFORE = 3;
const SNIPPET_AFTER_MAX = 14;
const SNIPPET_AFTER_MIN = 6;

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

export type LspTarget = {
  /** The checkout the server runs in (the review's attached directory). */
  readonly root: string;
  /** Repo-relative path of the hovered file. */
  readonly path: string;
  /** Identity of the text `loadText` returns: its blob SHA. */
  readonly contentKey: string;
  readonly loadText: () => Promise<string | null>;
  /** 1-based line, 0-based UTF-16 character. */
  readonly line: number;
  readonly character: number;
  readonly signal?: AbortSignal;
};

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
    const lines = text.split(/\r?\n/);
    const focus = Math.min(location.focus.line, Math.max(0, lines.length - 1));
    const start = Math.max(0, focus - SNIPPET_BEFORE);
    const declarationEnd = location.range?.end.line ?? focus;
    const end = Math.min(lines.length - 1, Math.max(focus + SNIPPET_AFTER_MIN, Math.min(declarationEnd, focus + SNIPPET_AFTER_MAX)));

    const rel = relative(session.root, file);
    const external = rel.startsWith('..') || isAbsolute(rel);
    const repoPath = external ? null : rel.split(sep).join('/');
    const home = homedir();
    return {
      path: repoPath ?? (file.startsWith(home + sep) ? `~${file.slice(home.length)}` : file),
      external,
      line: focus + 1,
      startLine: start + 1,
      snippet: lines.slice(start, end + 1).join('\n'),
      inReview: repoPath !== null && inReview(repoPath),
      server: spec.id,
    };
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

  /** Every running server, stopped; for shutdown. */
  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.#sessions.values(), (s) => this.#stop(s)));
  }

  async #prepare(
    target: LspTarget,
  ): Promise<{ client: LspClient; spec: ServerSpec; uri: string; session: Session } | null> {
    const lang = languageOf(target.path);
    if (lang === null) return null;
    const session = await this.#session(lang.language, target.root);
    const client = await session.client;
    if (client === null || session.spec === null || target.signal?.aborted === true) return null;
    const uri = pathToFileURL(`${target.root}/${target.path}`).href;
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
 * link's selection range, else the location's own range); `range` is the
 * whole declaration when the server says so (links only).
 */
function firstLocation(result: unknown): { uri: string; focus: Position; range: Range | null } | null {
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
    return {
      uri: loc.targetUri,
      focus: (loc.targetSelectionRange ?? loc.targetRange).start,
      range: loc.targetRange,
    };
  }
  if (typeof loc.uri === 'string' && loc.range !== undefined) {
    return { uri: loc.uri, focus: loc.range.start, range: null };
  }
  return null;
}
