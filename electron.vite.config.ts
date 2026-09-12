import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  main: {
    // better-sqlite3 is a native module: it must stay external and be loaded
    // from node_modules at runtime, not bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve('src/main/index.ts'),
          // Built alongside the app so the M1 checks exercise the real modules
          // against the real Electron ABI rather than a reimplementation.
          'm1-checks': path.resolve('src/main/m1-checks.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: path.resolve('src/preload/index.ts') },
        // .mjs so Electron loads it as ESM, matching `"type": "module"`.
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
  },
  renderer: {
    root: path.resolve('src/renderer'),
    plugins: [react(), tailwind()],
    resolve: { alias: { '@shared': path.resolve('src/shared') } },
    build: {
      rollupOptions: { input: { index: path.resolve('src/renderer/index.html') } },
    },
  },
});
