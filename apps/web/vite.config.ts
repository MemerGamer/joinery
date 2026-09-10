import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Inlined rather than imported from `@review/core`: `vite.config.ts` is
// loaded by Node's native ESM loader (not Vite's own transform pipeline),
// and `@review/core`'s package.json "exports" point straight at `.ts`
// source, which that loader can't resolve — `bun run vite build` fails with
// `ERR_UNKNOWN_FILE_EXTENSION` otherwise. Keep in sync with
// `packages/core/src/api.ts`'s `DEFAULT_PORT`.
const DEFAULT_PORT = 7317;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Required by @pierre/diffs' worker pool (SPEC §6.2): the highlighting
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
    // No SSR — this is a localhost app (SPEC §6.8).
    target: 'es2023',
    sourcemap: true,
  },
});
