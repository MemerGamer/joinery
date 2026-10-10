/**
 * A long-lived `git cat-file --batch` process per repo, for blob hydration
 * Measured: 400 blobs in 92 ms batched through one process versus
 * 738 ms spawning `git cat-file` once per blob — never spawn per blob.
 *
 * Framing per the git docs, and it must be parsed byte-exact rather than by
 * splitting on newlines, because the payload is arbitrary binary data that
 * can itself contain `\n`:
 *
 *   <oid> <type> <size>\n
 *   <exactly size bytes>\n
 *
 * or, for a missing object:
 *
 *   <oid> missing\n
 */
import { assertAllowed } from './run.ts';

const decoder = new TextDecoder();

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Buffers a `ReadableStream<Uint8Array>` so callers can pull exact byte
 * counts or lines. Consumed via async iteration rather than `.getReader()`
 * so it doesn't need to name `ReadableStreamDefaultReader` — under this
 * project's DOM-less lib config that type resolves ambiguously between
 * Bun's own streams global and `node:stream/web`'s.
 */
class ByteReader {
  #iterator: AsyncIterator<Uint8Array>;
  #buffered: Uint8Array = new Uint8Array(0);
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    if (this.#ended) return false;
    const { value, done } = await this.#iterator.next();
    if (done === true || value === undefined) {
      this.#ended = true;
      return false;
    }
    this.#buffered = concatBytes(this.#buffered, value);
    return true;
  }

  /** Reads up to and excluding the next `\n`. Returns null at EOF with nothing buffered. */
  async readLine(): Promise<string | null> {
    for (;;) {
      const idx = this.#buffered.indexOf(10);
      if (idx !== -1) {
        const line = this.#buffered.slice(0, idx);
        this.#buffered = this.#buffered.slice(idx + 1);
        return decoder.decode(line);
      }
      if (!(await this.#fill())) {
        if (this.#buffered.length > 0) {
          const line = this.#buffered;
          this.#buffered = new Uint8Array(0);
          return decoder.decode(line);
        }
        return null;
      }
    }
  }

  /** Reads exactly `n` bytes, buffering across chunk boundaries. Throws at EOF. */
  async readExact(n: number): Promise<Uint8Array> {
    while (this.#buffered.length < n) {
      if (!(await this.#fill())) {
        throw new Error(
          `cat-file stream ended before ${String(n)} bytes were available (had ${String(this.#buffered.length)})`,
        );
      }
    }
    const out = this.#buffered.slice(0, n);
    this.#buffered = this.#buffered.slice(n);
    return out;
  }
}

function spawnCatFileBatch(cwd: string) {
  return Bun.spawn(['git', 'cat-file', '--batch'], {
    cwd,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

type CatFileProcess = ReturnType<typeof spawnCatFileBatch>;

/**
 * One `git cat-file --batch` process, reused across many `readBlob(s)` calls.
 * Requests are serialized (batch mode is a strict request/response protocol
 * over one pipe) and the process is transparently restarted if it dies.
 */
export class CatFile {
  readonly #cwd: string;
  #proc: CatFileProcess | null = null;
  #reader: ByteReader | null = null;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  #ensureProcess(): { proc: CatFileProcess; reader: ByteReader } {
    if (this.#closed) {
      throw new Error('CatFile is closed');
    }
    if (this.#proc === null || this.#proc.exitCode !== null) {
      // Documents that this bypasses run()'s subcommand dispatch (it's a
      // long-lived process, not a request/response call) while still going
      // through the same allowlist check.
      assertAllowed(['cat-file', '--batch'], undefined);
      const proc = spawnCatFileBatch(this.#cwd);
      this.#proc = proc;
      this.#reader = new ByteReader(proc.stdout);
    }
    // Non-null by construction above.
    const proc = this.#proc;
    const reader = this.#reader;
    if (reader === null) {
      throw new Error('unreachable: reader missing after ensureProcess');
    }
    return { proc, reader };
  }

  /** Read one blob. Returns null if the object does not exist. */
  async readBlob(oid: string): Promise<Uint8Array | null> {
    const result = await this.readBlobs([oid]);
    return result.get(oid) ?? null;
  }

  /**
   * Read many blobs through one batch process invocation. Returns a map from
   * oid to its bytes, or null for oids that do not exist as objects.
   */
  async readBlobs(oids: readonly string[]): Promise<Map<string, Uint8Array | null>> {
    if (oids.length === 0) return new Map();

    // Serialize this batch behind any batch already in flight, since the
    // protocol is strict request/response order over one shared pipe.
    const previous = this.#queue;
    let release: () => void = () => {};
    this.#queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // One retry: if the process was killed or died between our liveness
      // check and actually writing/reading (e.g. an external kill lands in
      // that window, or `exitCode` hasn't been updated by the runtime yet),
      // the first attempt fails cleanly, drops the dead process, and the
      // retry spawns a fresh one. A second consecutive failure is a real
      // problem and propagates.
      try {
        return await this.#readBlobsSerial(oids);
      } catch (err) {
        if (this.#closed) throw err;
        this.#proc = null;
        this.#reader = null;
        void err; // surfaced only if the retry also fails
        return await this.#readBlobsSerial(oids);
      }
    } finally {
      release();
    }
  }

  async #readBlobsSerial(oids: readonly string[]): Promise<Map<string, Uint8Array | null>> {
    const { proc, reader } = this.#ensureProcess();

    const input = oids.map((oid) => `${oid}\n`).join('');
    proc.stdin.write(input);
    await proc.stdin.flush();

    const result = new Map<string, Uint8Array | null>();
    for (const oid of oids) {
      const header = await reader.readLine();
      if (header === null) {
        // The process died mid-batch. Drop it so a retry (or the next call)
        // restarts fresh; this batch is a loss for its remaining oids.
        this.#proc = null;
        this.#reader = null;
        throw new Error(`cat-file --batch process ended unexpectedly while reading ${oid}`);
      }

      const parts = header.split(' ');
      if (parts.length === 2 && parts[1] === 'missing') {
        result.set(oid, null);
        continue;
      }

      const type = parts[1];
      const sizeText = parts[2];
      if (parts.length < 3 || type === undefined || sizeText === undefined) {
        throw new Error(`unexpected cat-file --batch header: ${JSON.stringify(header)}`);
      }
      const size = Number(sizeText);
      if (!Number.isInteger(size) || size < 0) {
        throw new Error(`unexpected cat-file --batch size in header: ${JSON.stringify(header)}`);
      }

      const content = await reader.readExact(size);
      await reader.readExact(1); // trailing LF after the payload
      result.set(oid, content);
    }
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#proc !== null) {
      try {
        this.#proc.stdin.end();
      } catch {
        // already gone
      }
      this.#proc.kill();
    }
    this.#proc = null;
    this.#reader = null;
  }

  /**
   * Test-only: kill the underlying process without marking this `CatFile`
   * closed, to exercise the "restart if it dies" behavior without needing
   * to reach into private state from outside the module.
   */
  killUnderlyingProcessForTest(): void {
    this.#proc?.kill();
  }
}
