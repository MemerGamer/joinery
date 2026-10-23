/**
 * A minimal LSP client over stdio: Content-Length framing, request/response
 * correlation, `$/cancelRequest` on abort, and polite answers to the few
 * server→client requests real servers block on (`workspace/configuration`,
 * `client/registerCapability`, `window/workDoneProgress/create`).
 *
 * Only what hover, go-to-definition and its kin need — no diagnostics, no edits. The
 * client advertises UTF-16 positions (the LSP default), which is also how
 * JavaScript strings index, so a browser-side character offset is already
 * an LSP `character`.
 */
import { pathToFileURL } from 'node:url';

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string };

export class LspError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.name = 'LspError';
    this.code = code;
  }
}

/** `RequestCancelled`/`ContentModified`: the answer no longer matters, not a failure. */
export function isCancelled(err: unknown): boolean {
  return err instanceof LspError && (err.code === -32800 || err.code === -32801);
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function indexOfHeaderEnd(buf: Uint8Array): number {
  outer: for (let i = 0; i + 3 < buf.length; i++) {
    for (let j = 0; j < 4; j++) if (buf[i + j] !== HEADER_END[j]) continue outer;
    return i;
  }
  return -1;
}

export type LspClientParams = {
  readonly command: readonly string[];
  readonly root: string;
  readonly initializationOptions?: unknown;
  readonly env?: Readonly<Record<string, string>>;
  readonly onExit?: (code: number | null) => void;
  readonly onNotification?: (method: string, params: unknown) => void;
};

export class LspClient {
  readonly #proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  readonly #pending = new Map<number, Pending>();
  readonly #root: string;
  readonly #onNotification: LspClientParams['onNotification'];
  #nextId = 1;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #exited = false;
  #stderrTail = '';

  private constructor(params: LspClientParams) {
    this.#root = params.root;
    this.#onNotification = params.onNotification;
    this.#proc = Bun.spawn([...params.command], {
      cwd: params.root,
      ...(params.env !== undefined ? { env: { ...process.env, ...params.env } } : {}),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void this.#readLoop();
    void this.#drainStderr();
    void this.#proc.exited.then((code) => {
      this.#exited = true;
      const detail = this.#stderrTail.trim().split('\n').slice(-3).join(' | ');
      for (const p of this.#pending.values()) {
        p.reject(new Error(`language server exited (${code})${detail ? `: ${detail}` : ''}`));
      }
      this.#pending.clear();
      params.onExit?.(code);
    });
  }

  /** Spawns the server and completes the `initialize`/`initialized` handshake. */
  static async start(params: LspClientParams): Promise<LspClient> {
    const client = new LspClient(params);
    const rootUri = pathToFileURL(params.root).href;
    try {
      await client.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'joinery' },
        rootUri,
        rootPath: params.root,
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
        initializationOptions: params.initializationOptions ?? null,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
            definition: { dynamicRegistration: false, linkSupport: true },
            implementation: { dynamicRegistration: false, linkSupport: true },
            documentHighlight: { dynamicRegistration: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: false },
        },
      });
    } catch (err) {
      client.dispose();
      throw err;
    }
    client.notify('initialized', {});
    return client;
  }

  get exited(): boolean {
    return this.#exited;
  }

  get pid(): number {
    return this.#proc.pid;
  }

  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#exited) return Promise.reject(new Error('language server is not running'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(new LspError(method, -32800, 'cancelled'));
      };
      if (signal?.aborted === true) {
        reject(new LspError(method, -32800, 'cancelled'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value as T);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#exited) return;
    this.#send({ jsonrpc: '2.0', method, params });
  }

  /** `shutdown` + `exit`, then a kill if the server lingers. */
  async stop(): Promise<void> {
    if (this.#exited) return;
    const timeout = new Promise((resolve) => setTimeout(resolve, 1_500));
    await Promise.race([this.request('shutdown', null).catch(() => undefined), timeout]);
    this.notify('exit', null);
    await Promise.race([this.#proc.exited, timeout]);
    this.dispose();
  }

  dispose(): void {
    if (!this.#exited) this.#proc.kill();
  }

  #send(message: unknown): void {
    const body = encoder.encode(JSON.stringify(message));
    const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    try {
      this.#proc.stdin.write(header);
      this.#proc.stdin.write(body);
      this.#proc.stdin.flush();
    } catch {
      // The exit handler rejects whatever was pending.
    }
  }

  async #readLoop(): Promise<void> {
    try {
      for await (const chunk of this.#proc.stdout) {
        const next = new Uint8Array(this.#buffer.length + chunk.length);
        next.set(this.#buffer);
        next.set(chunk, this.#buffer.length);
        this.#buffer = next;
        this.#drainMessages();
      }
    } catch {
      // Stream closed with the process.
    }
  }

  #drainMessages(): void {
    for (;;) {
      const headerEnd = indexOfHeaderEnd(this.#buffer);
      if (headerEnd === -1) return;
      const header = decoder.decode(this.#buffer.subarray(0, headerEnd));
      const length = Number.parseInt(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? '', 10);
      if (!Number.isFinite(length)) {
        // Unframed noise; drop through the header and resynchronize.
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      if (this.#buffer.length < start + length) return;
      const body = decoder.decode(this.#buffer.subarray(start, start + length));
      this.#buffer = this.#buffer.subarray(start + length);
      try {
        this.#dispatch(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // A malformed message is skipped, never fatal.
      }
    }
  }

  #dispatch(msg: Record<string, unknown>): void {
    const id = msg['id'];
    const method = msg['method'];
    if (typeof method === 'string') {
      if (id !== undefined && id !== null) this.#answerServerRequest(id, method, msg['params']);
      else this.#onNotification?.(method, msg['params']);
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    const error = msg['error'] as { code?: number; message?: string } | undefined;
    if (error !== undefined) pending.reject(new LspError(pending.method, error.code ?? 0, error.message ?? 'error'));
    else pending.resolve(msg['result'] ?? null);
  }

  #answerServerRequest(id: unknown, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === 'workspace/configuration') {
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
      result = items.map(() => null);
    } else if (method === 'workspace/workspaceFolders') {
      result = [{ uri: pathToFileURL(this.#root).href, name: 'root' }];
    }
    this.#send({ jsonrpc: '2.0', id, result });
  }

  async #drainStderr(): Promise<void> {
    try {
      for await (const chunk of this.#proc.stderr) {
        this.#stderrTail = (this.#stderrTail + decoder.decode(chunk)).slice(-2_000);
      }
    } catch {
      // Stream closed with the process.
    }
  }
}
