import { defineConfig } from 'vite';

// Dev-server config that simply serves the e2e fixtures (e2e/fixtures/*.html) as-is.
// vite.config.ts is dedicated to building the library into dist, so it isn't used here.
export default defineConfig({
  root: __dirname,
  publicDir: false,
  server: {
    // A different port from demo/vite.config.ts's default (5173), so running demo and e2e
    // together doesn't point Playwright at the wrong server. strictPort fails loudly on a
    // collision instead of silently drifting, which would break playwright.config.ts's
    // hardcoded URLs.
    port: 5174,
    strictPort: true,
  },
});
