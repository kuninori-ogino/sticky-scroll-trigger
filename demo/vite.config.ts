import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// sticky-scroll-trigger is an in-house package never published to npm, and its package.json has
// no main/types (vite-plugin-dts, designed for the library build, gets confused
// when package.json's types/main are referenced).
// So imports from the demo always resolve via an alias pointing directly at src,
// without waiting on a build output.
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      'sticky-scroll-trigger': resolve(import.meta.dirname, '../src/index.ts'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
});
