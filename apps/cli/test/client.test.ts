import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, _resetTokenCache, listRepos } from '../src/client.ts';

const originalFetch = globalThis.fetch;

function mockFetch(response: { status: number; body: unknown }): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'joinery-cli-test-'));
  writeFileSync(join(dataDir, 'token'), 'test-token-value\n');
  process.env['JOINERY_DATA_DIR'] = dataDir;
  process.env['JOINERY_URL'] = 'http://127.0.0.1:7317';
  _resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env['JOINERY_DATA_DIR'];
  delete process.env['JOINERY_URL'];
});

describe('client error mapping', () => {
  test('parses a successful response through the route schema', async () => {
    mockFetch({
      status: 200,
      body: {
        repos: [
          {
            id: 'r1',
            rootPath: '/tmp/repo',
            remoteOwner: null,
            remoteName: null,
            defaultBranch: 'main',
            createdAt: 0,
          },
        ],
      },
    });
    const result = await listRepos();
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]?.id).toBe('r1');
  });

  test('maps a structured error body to code, message, and hint', async () => {
    mockFetch({
      status: 404,
      body: {
        error: {
          code: 'not_found',
          message: 'repo not found',
          hint: 'run `joinery repos add <path>` first',
        },
      },
    });
    await expect(listRepos()).rejects.toMatchObject({
      name: 'ApiError',
      code: 'not_found',
      message: 'repo not found',
      hint: 'run `joinery repos add <path>` first',
    });
  });

  test('an error status with an unstructured body still produces an ApiError', async () => {
    mockFetch({ status: 500, body: { oops: true } });
    let caught: unknown;
    try {
      await listRepos();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('internal');
    expect((caught as ApiError).message).toContain('500');
  });

  test('a response that fails the route response schema is a clean ApiError, not a crash', async () => {
    mockFetch({ status: 200, body: { repos: 'not-an-array' } });
    let caught: unknown;
    try {
      await listRepos();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('internal');
    expect((caught as ApiError).message).toContain('unexpected response shape');
  });

  test('a network failure is surfaced as an ApiError with a hint', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    let caught: unknown;
    try {
      await listRepos();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).hint).toContain('server running');
  });

  test('a missing token file is a clean unauthorized ApiError', async () => {
    rmSync(join(dataDir, 'token'));
    let caught: unknown;
    try {
      await listRepos();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('unauthorized');
  });
});
