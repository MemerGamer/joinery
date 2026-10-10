import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// Inlined rather than imported from `@review/core`: `vite.config.ts` is
// loaded by Node's native ESM loader (not Vite's own transform pipeline),
// and `@review/core`'s package.json "exports" point straight at `.ts`
// source, which that loader can't resolve — `bun run vite build` fails with
// `ERR_UNKNOWN_FILE_EXTENSION` otherwise. Keep in sync with
// `packages/core/src/api.ts`'s `DEFAULT_PORT`.
const DEFAULT_PORT = 7317;

const TOKEN_PLACEHOLDER = '__REVIEW_TOKEN_PLACEHOLDER__';

/**
 * Hands the browser the bearer token at page load.
 *
 * Only in dev: `vite build` leaves the placeholder in `dist/index.html` so the
 * server substitutes the current token at serve time, and a rotated token does
 * not require a rebuild. A token baked into a build artifact would also outlive
 * the process that owns it.
 */
function reviewToken(): Plugin {
  return {
    name: 'review-token',
    apply: 'serve',
    transformIndexHtml(html) {
      const dataDir = process.env['REVIEW_DATA_DIR'] ?? fileURLToPath(new URL('../../data', import.meta.url));
      try {
        const token = readFileSync(`${dataDir}/token`, 'utf8').trim();
        return html.replace(TOKEN_PLACEHOLDER, token);
      } catch {
        // Server has never run, so there is no token yet. Leave the
        // placeholder: the app renders its "can't reach the server" state.
        return html;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), reviewToken()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Required by @pierre/diffs' worker pool: the highlighting
  // workers are ES modules, and the default 'iife' format silently breaks them.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${DEFAULT_PORT}`,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    // No SSR — this is a localhost app.
    target: 'es2023',
    sourcemap: true,
  },
});
