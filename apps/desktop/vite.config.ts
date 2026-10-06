import { defineConfig } from 'vite';

/**
 * Renderer build for the local recorder.
 *
 * No framework plugin is required: Vite transforms `.tsx` through esbuild using `tsconfig.json`
 * (`jsx: "react-jsx"`). That keeps the dependency surface of this workspace to exactly what the rest of
 * the monorepo already pins.
 *
 * Phase 2 has no network layer at all — there is deliberately no proxy, no API base URL, and no
 * environment variable to read. The only host the renderer talks to is the Tauri IPC bridge (see
 * `src/bridge.ts`), and `tests/desktop/recorder-offline-boundary.test.ts` fails the build if that changes.
 */
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
    // The Arena preview proxies this port under a `*.e2b.app` host; allow it so the dev server answers
    // instead of rejecting the Host header. No other hosts are permitted.
    allowedHosts: ['.e2b.app'],
  },
  envPrefix: ['VITE_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
