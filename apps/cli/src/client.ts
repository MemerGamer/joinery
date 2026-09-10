/**
 * A thin typed client over the HTTP API (SPEC §10).
 *
 * It calls through the `api` route map from `@review/core` for method, path,
 * and request/response schemas, so a route or payload change in core is a
 * compile error here, not a runtime 404.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  api,
  DEFAULT_PORT,
  errorResponseSchema,
  type ApiOperation,
  type BodyOf,
  type ErrorResponse,
  type ResponseOf,
} from '@review/core';
import type { DiffQuery } from '@review/core';

/** A structured API error: the server's `{code, message, hint}` shape. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ErrorResponse['error']['code'];
  readonly hint: string | undefined;

  constructor(code: ErrorResponse['error']['code'], message: string, hint: string | undefined) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// --- configuration: base URL and bearer token ---

export function baseUrl(): string {
  return process.env['REVIEW_URL'] ?? `http://127.0.0.1:${DEFAULT_PORT}`;
}

/** Walks up from `startDir` looking for the workspace root marker. */
function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'tsconfig.base.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * The app's own `data/` directory, resolved relative to the CLI itself (its
 * source file in dev, or the compiled binary's own path when run as
 * `dist/review`) — never a user dot-folder. `REVIEW_DATA_DIR` overrides.
 */
export function dataDir(): string {
  const override = process.env['REVIEW_DATA_DIR'];
  if (override !== undefined && override.length > 0) return override;

  const candidateDirs: string[] = [];
  try {
    candidateDirs.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // import.meta.url is not a file:// URL inside a compiled binary.
  }
  candidateDirs.push(dirname(process.execPath));
  candidateDirs.push(process.cwd());

  for (const start of candidateDirs) {
    const root = findRepoRoot(start);
    if (root !== undefined) return join(root, 'data');
  }
  return join(process.cwd(), 'data');
}

let cachedToken: string | undefined;

function readToken(): string {
  if (cachedToken !== undefined) return cachedToken;
  const tokenPath = join(dataDir(), 'token');
  let raw: string;
  try {
    raw = readFileSync(tokenPath, 'utf8');
  } catch {
    throw new ApiError(
      'unauthorized',
      `could not read bearer token at ${tokenPath}`,
      'start the review server first, or set REVIEW_DATA_DIR to a data/ directory containing a token file',
    );
  }
  cachedToken = raw.trim();
  return cachedToken;
}

// --- low-level request plumbing ---

/**
 * `api[op].path` is typed `(...args: never[]) => string` at the `Api` map
 * level (core's `RouteDef`), so real path arguments (e.g. a review id) are
 * not callable through it without a cast. The cast is confined to this one
 * helper; every route still comes from `api`, so a renamed route is still a
 * compile error at the call sites below.
 */
async function send<K extends ApiOperation>(
  op: K,
  opts: { path: string; body?: unknown; query?: Readonly<Record<string, string | undefined>> },
): Promise<ResponseOf<K>> {
  const routeDef = api[op];
  const url = new URL(opts.path, baseUrl());
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const hasBody = opts.body !== undefined;
  // Resolved before the try below so a local token-read failure surfaces as
  // its own `unauthorized` ApiError, not a generic network-failure one.
  const authorization = `Bearer ${readToken()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: routeDef.method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        authorization,
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      'internal',
      `could not reach the review server at ${baseUrl()}: ${reason}`,
      'is the server running? check REVIEW_URL if it is not on the default port',
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const parsedErr = errorResponseSchema.safeParse(json);
    if (parsedErr.success) {
      throw new ApiError(parsedErr.data.error.code, parsedErr.data.error.message, parsedErr.data.error.hint);
    }
    throw new ApiError('internal', `request failed with HTTP ${res.status}`, undefined);
  }

  const parsed = routeDef.response.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('internal', `unexpected response shape from server: ${parsed.error.message}`, undefined);
  }
  return parsed.data as ResponseOf<K>;
}

// --- one wrapper per route ---

export function listRepos(): Promise<ResponseOf<'listRepos'>> {
  return send('listRepos', { path: api.listRepos.path() });
}

export function addRepo(body: BodyOf<'addRepo'>): Promise<ResponseOf<'addRepo'>> {
  return send('addRepo', { path: api.addRepo.path(), body });
}

export function listReviews(): Promise<ResponseOf<'listReviews'>> {
  return send('listReviews', { path: api.listReviews.path() });
}

export function createReview(body: BodyOf<'createReview'>): Promise<ResponseOf<'createReview'>> {
  return send('createReview', { path: api.createReview.path(), body });
}

export function getReview(id: string): Promise<ResponseOf<'getReview'>> {
  return send('getReview', { path: api.getReview.path(id) });
}

export function getFiles(id: string): Promise<ResponseOf<'getFiles'>> {
  return send('getFiles', { path: api.getFiles.path(id) });
}

export function getDiff(id: string, query: DiffQuery): Promise<ResponseOf<'getDiff'>> {
  return send('getDiff', {
    path: api.getDiff.path(id),
    query: { path: query.path, rev: query.rev },
  });
}

export function getReadingOrder(id: string): Promise<ResponseOf<'getReadingOrder'>> {
  return send('getReadingOrder', { path: api.getReadingOrder.path(id) });
}

export function setReadingOrder(
  id: string,
  body: BodyOf<'setReadingOrder'>,
): Promise<ResponseOf<'setReadingOrder'>> {
  return send('setReadingOrder', { path: api.setReadingOrder.path(id), body });
}

export function generateReadingOrder(id: string): Promise<ResponseOf<'generateReadingOrder'>> {
  return send('generateReadingOrder', { path: api.generateReadingOrder.path(id), body: {} });
}

export function listThreads(
  id: string,
  opts: { unresolved?: boolean } = {},
): Promise<ResponseOf<'listThreads'>> {
  return send('listThreads', {
    path: api.listThreads.path(id),
    query: { status: opts.unresolved === true ? 'open' : undefined },
  });
}

export function getThread(id: string): Promise<ResponseOf<'getThread'>> {
  return send('getThread', { path: api.getThread.path(id) });
}

export function reply(id: string, body: BodyOf<'reply'>): Promise<ResponseOf<'reply'>> {
  return send('reply', { path: api.reply.path(id), body });
}

export function resolveThread(
  id: string,
  body: BodyOf<'resolveThread'> = { resolved: true },
): Promise<ResponseOf<'resolveThread'>> {
  return send('resolveThread', { path: api.resolveThread.path(id), body });
}

export function feedback(
  id: string,
  opts: { unresolved?: boolean } = {},
): Promise<ResponseOf<'feedback'>> {
  return send('feedback', {
    path: api.feedback.path(id),
    query: { format: 'markdown', unresolved: opts.unresolved === true ? 'true' : undefined },
  });
}

export function setRevision(id: string, body: BodyOf<'setRevision'>): Promise<ResponseOf<'setRevision'>> {
  return send('setRevision', { path: api.setRevision.path(id), body });
}

export function markViewed(id: string, path: string): Promise<ResponseOf<'markViewed'>> {
  return send('markViewed', { path: api.markViewed.path(id), body: { path, viewed: true } });
}

export function getRun(id: string): Promise<ResponseOf<'getRun'>> {
  return send('getRun', { path: api.getRun.path(id) });
}

/** Exposed for tests: clears the cached bearer token between cases. */
export function _resetTokenCache(): void {
  cachedToken = undefined;
}
