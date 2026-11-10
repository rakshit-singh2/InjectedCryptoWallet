import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Four entry points: the popup (React), the background service worker (ES module) and two content
// scripts. Content scripts cannot import chunks, so they are kept dependency-free; the
// `extension build output` test fails the suite if a chunk import ever appears in them.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background/index.js'),
        content: resolve(__dirname, 'src/contentscript/content.js'),
        provider: resolve(__dirname, 'src/contentscript/provider.js'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
