/**
 * `errorResponseSchema` (`code`, `message`, optional actionable `hint`) as a
 * throwable, plus the Hono error handler that renders it.
 */
import type { Context } from 'hono';
import type { ErrorResponse } from '@joinery/core';

export type ErrorCode = ErrorResponse['error']['code'];

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(status: number, code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }

  toResponse(): ErrorResponse {
    return this.hint === undefined
      ? { error: { code: this.code, message: this.message } }
      : { error: { code: this.code, message: this.message, hint: this.hint } };
  }
}

export const notFound = (message: string, hint?: string): HttpError => new HttpError(404, 'not_found', message, hint);
export const badRequest = (message: string, hint?: string): HttpError =>
  new HttpError(400, 'bad_request', message, hint);
export const conflict = (message: string, hint?: string): HttpError => new HttpError(409, 'conflict', message, hint);
export const unauthorized = (message: string, hint?: string): HttpError =>
  new HttpError(401, 'unauthorized', message, hint);
export const gitError = (message: string, hint?: string): HttpError => new HttpError(502, 'git_error', message, hint);
export const internal = (message: string, hint?: string): HttpError => new HttpError(500, 'internal', message, hint);

/** Registered with `app.onError`. Anything not already an `HttpError` becomes a generic 500. */
export function renderError(err: unknown, c: Context): Response {
  const httpError = err instanceof HttpError ? err : new HttpError(500, 'internal', errorMessage(err));
  if (!(err instanceof HttpError)) {
    // eslint-disable-next-line no-console -- surfaced only for unexpected errors
    console.error(err);
  }
  return c.json(httpError.toResponse(), httpError.status as 400 | 401 | 404 | 409 | 500 | 502);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
