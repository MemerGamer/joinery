import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { DEFAULT_PORT } from '@review/core';

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
