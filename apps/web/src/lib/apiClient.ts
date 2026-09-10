/**
 * Thin typed fetch wrapper over the route map in `@review/core`'s `api.ts`.
 *
 * The server may not be reachable (it's being built concurrently) — every
 * call surfaces a typed `ApiError` so the UI can degrade to a clear empty
 * state instead of throwing into the void.
 */
import {
  api,
  type Api,
  type ApiOperation,
  type BodyOf,
  type PathArgsOf,
  type QueryOf,
  type ResponseOf,
} from '@review/core';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, status: number, code?: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

let token: string | null = null;

export function setAuthToken(next: string | null): void {
  token = next;
}

export function getAuthToken(): string | null {
  return token;
}

function buildQuery(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

export async function callApi<K extends ApiOperation>(
  op: K,
  options: {
    params?: PathArgsOf<K>;
    body?: BodyOf<K>;
    query?: QueryOf<K>;
    signal?: AbortSignal;
  } = {},
): Promise<ResponseOf<K>> {
  const route = api[op] as Api[K];
  const pathFn = route.path as (...args: never[]) => string;
  const args = (options.params ?? []) as never[];
  const path = pathFn(...args);
  const qs = buildQuery(options.query as Record<string, unknown> | undefined);

  const headers: Record<string, string> = {};
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  let bodyText: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyText = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`${path}${qs}`, {
      method: route.method,
      headers,
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? err.message : 'Network request failed',
      0,
      'network_error',
    );
  }

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    let code: string | undefined;
    let hint: string | undefined;
    try {
      const parsed: unknown = await res.json();
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error: unknown }).error === 'object' &&
        (parsed as { error: unknown }).error !== null
      ) {
        const e = (parsed as { error: { message?: unknown; code?: unknown; hint?: unknown } })
          .error;
        if (typeof e.message === 'string') message = e.message;
        if (typeof e.code === 'string') code = e.code;
        if (typeof e.hint === 'string') hint = e.hint;
      }
    } catch {
      // body wasn't JSON; fall back to the status-based message
    }
    throw new ApiError(message, res.status, code, hint);
  }

  return (await res.json()) as ResponseOf<K>;
}
