import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Desktop cloud boundary.
 *
 * This file used to be `recorder-offline-boundary.test.ts` and forbade *any* network anywhere in the
 * desktop app. That rule was correct for Phase 2 (local capture only). One-tap recording changed the
 * requirement: the app must now create meetings, upload chunks, and observe processing state, which
 * means it must be able to reach the SUHBAT API.
 *
 * The rule was therefore not removed — it was made precise. The property that actually matters is not
 * "no network", it is:
 *
 *   1. **One door.** Exactly one renderer file (`src/cloud.ts`) may perform a network request. Every
 *      other file is statically proven incapable of one, so auditing the credential surface is
 *      auditing one file.
 *   2. **No secret can reach the renderer.** No Supabase client, no `@suhbat/database` import (that
 *      package is server-only and pulls in service-role shapes), and no provider SDK. The renderer
 *      holds an opaque user-issued session token and a short-lived signed URL, and nothing else.
 *   3. **No hardcoded endpoint.** Only `cloud.ts` may contain a host, and the API origin is a build
 *      variable with no default, so an unconfigured build stays local instead of guessing a server.
 *   4. **Capture stays offline.** The recorder crates — the code that owns the microphone, the
 *      manifest, and the timeline — are still forbidden from touching the network, a database, or a
 *      provider. An unreachable server cannot affect a recording in progress.
 *   5. **The webview gets no new capability.** No shell, fs, http, opener, or dialog plugin
 *      permission is granted; the browser is opened by one narrow Rust command, and chunk bytes are
 *      read by another that validates the path against the session directory.
 */

const ROOT = join(__dirname, '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const CLOUD_MODULE = join(DESKTOP, 'src', 'cloud.ts');

function walk(dir: string, filter: (path: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'target' || entry === '.git')
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, filter));
    } else if (filter(full)) {
      found.push(full);
    }
  }
  return found;
}

const rendererFiles = walk(join(DESKTOP, 'src'), (path) => /\.(ts|tsx)$/.test(path));
const rustFiles = walk(DESKTOP, (path) => path.endsWith('.rs'));
const manifestFiles = walk(
  DESKTOP,
  (path) => path.endsWith('Cargo.toml') || path === join(DESKTOP, 'package.json'),
);
const configFiles = [
  join(DESKTOP, 'vite.config.ts'),
  join(DESKTOP, 'index.html'),
  join(DESKTOP, 'package.json'),
  join(DESKTOP, 'src-tauri', 'Cargo.toml'),
  join(DESKTOP, 'src-tauri', 'tauri.conf.json'),
  join(DESKTOP, 'src-tauri', 'capabilities', 'default.json'),
];

/** Strips comments so a doc comment that *mentions* `fetch` cannot fail the build. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Drops `#[cfg(test)]` modules so test-only temp-directory cleanup cannot mask a real deletion. */
function stripTestModules(text: string): string {
  const index = text.indexOf('#[cfg(test)]');
  return index === -1 ? text : text.slice(0, index);
}

const FORBIDDEN_RENDERER: Array<[string, RegExp]> = [
  ['fetch()', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /new\s+WebSocket|WebSocket\(/],
  ['EventSource', /new\s+EventSource/],
  ['sendBeacon', /navigator\.sendBeacon/],
  ['absolute http(s) URL', /["'`]https?:\/\//],
  ['hardcoded host or loopback', /\b(localhost|127\.0\.0\.1)\b/],
  ['Supabase client', /@supabase|createClient\s*\(/],
  ['database package', /@suhbat\/database/],
  ['provider SDKs', /\b(openai|assemblyai|deepgram|whisper|rev_ai)\b/i],
  ['environment access', /import\.meta\.env/],
  ['local static server', /createServer|http\.createServer/],
];

/** `cloud.ts` is the one allowed door, so it gets a shorter, sharper list. */
const FORBIDDEN_IN_CLOUD: Array<[string, RegExp]> = [
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /new\s+WebSocket|WebSocket\(/],
  ['Supabase client', /@supabase|createClient\s*\(/],
  ['database package', /@suhbat\/database/],
  ['provider SDKs', /\b(openai|assemblyai|deepgram|whisper|rev_ai)\b/i],
  ['a concrete remote host', /["'`]https?:\/\/(?!\$|)[A-Za-z0-9.-]+\.[a-z]{2,}/],
  ['any other environment variable', /import\.meta\.env\.(?!VITE_SUHBAT_API_BASE_URL)/],
  ['credential-shaped identifier', /\b(serviceRole|service_role|apiKey|secretKey|api[_-]?key|bearer[A-Z])\b/i],
];

const FORBIDDEN_RUST: Array<[string, RegExp]> = [
  ['reqwest', /\breqwest\b/],
  ['hyper', /\bhyper\b/],
  ['tungstenite / websockets', /tungstenite|websockets?/],
  ['ureq', /\bureq\b/],
  ['Supabase / Postgraphile', /supabase|postgrest|graphile/],
  ['SQL clients', /\b(sqlx|postgres|rusqlite|diesel|tokio-postgres)\b/],
  ['object storage SDKs', /\b(aws-sdk|rust-s3|minio|azure_storage)\b/],
  ['transcription providers', /assemblyai|openai|whisper|deepgram/i],
  ['Telegram', /telegram/i],
  ['credential storage crates', /keyring|security-framework/],
  ['local web server crates', /\b(axum|warp|actix|rocket|tiny_http)\b/],
];

const ALLOWED_IMPORTS = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'zod',
  '@suhbat/contracts',
  '@suhbat/shared',
]);

describe('desktop renderer has exactly one network door', () => {
  it('covers the renderer and Rust sources it is supposed to', () => {
    expect(rendererFiles.length).toBeGreaterThanOrEqual(8);
    expect(rustFiles.length).toBeGreaterThanOrEqual(15);
    expect(existsSync(CLOUD_MODULE), 'src/cloud.ts must exist: it is the only allowed network module').toBe(
      true,
    );
  });

  it('finds no network primitive in any renderer file except cloud.ts', () => {
    for (const file of rendererFiles) {
      if (file === CLOUD_MODULE) continue;
      const text = code(readFileSync(file, 'utf8'));
      for (const [label, pattern] of FORBIDDEN_RENDERER) {
        expect(pattern.test(text), `${relative(ROOT, file)} contains ${label}`).toBe(false);
      }
    }
  });

  it('keeps cloud.ts itself free of everything but the one configured origin', () => {
    const text = code(readFileSync(CLOUD_MODULE, 'utf8'));
    for (const [label, pattern] of FORBIDDEN_IN_CLOUD) {
      expect(pattern.test(text), `src/cloud.ts contains ${label}`).toBe(false);
    }
    // The door must actually be usable, so the check is paired with a positive requirement.
    expect(text).toContain('VITE_SUHBAT_API_BASE_URL');
    expect(text).toMatch(/typeof fetch|fetch\(/);
  });

  it('proves the API origin has no default value', () => {
    const text = code(readFileSync(CLOUD_MODULE, 'utf8'));
    // A baked-in fallback would silently send someone's meeting audio to whoever owns that domain.
    const urlFunction = /function cloudBaseUrl[\s\S]*?\n}/.exec(text)?.[0] ?? '';
    expect(urlFunction).toBeTruthy();
    expect(urlFunction).toContain('VITE_SUHBAT_API_BASE_URL');
    expect(urlFunction).not.toMatch(/return\s+["'`]https?:/);
  });

  it('imports only the approved package set', () => {
    for (const file of rendererFiles) {
      const text = code(readFileSync(file, 'utf8'));
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        const allowed = specifier.startsWith('./') || specifier.startsWith('../') || ALLOWED_IMPORTS.has(specifier);
        expect(allowed, `${relative(ROOT, file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('never persists a provider credential in local storage', () => {
    const store = code(readFileSync(join(DESKTOP, 'src', 'session-store.ts'), 'utf8'));
    for (const forbidden of ['password', 'apiKey', 'serviceRole', 'assemblyai', 'openai', 'secret']) {
      expect(store.toLowerCase()).not.toContain(forbidden);
    }
    // The one thing it stores is the opaque session token.
    expect(store).toContain('token');
  });
});

describe('recorder crates stay offline', () => {
  for (const [label, pattern] of FORBIDDEN_RUST) {
    it(`Rust sources contain no ${label}`, () => {
      for (const file of rustFiles) {
        const text = code(readFileSync(file, 'utf8'));
        expect(pattern.test(text), `${relative(ROOT, file)} mentions ${label}`).toBe(false);
      }
    });
  }

  it('declares no network or provider dependency', () => {
    for (const file of manifestFiles) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of [
        'reqwest',
        'hyper',
        'sqlx',
        'supabase',
        'openai',
        'assemblyai',
        'rust-s3',
        'keyring',
      ]) {
        expect(text.includes(forbidden), `${relative(ROOT, file)} depends on ${forbidden}`).toBe(false);
      }
    }
  });

  it('keeps every network-shaped Rust call behind a documented, single-purpose command', () => {
    const commands = code(readFileSync(join(DESKTOP, 'src-tauri', 'src', 'commands.rs'), 'utf8'));
    // The browser opener is the only place a child process is spawned, and it is cfg-gated per target.
    const spawnCalls = (commands.match(/std::process::Command::new/g) ?? []).length;
    const gates = (commands.match(/#\[cfg\(target_os/g) ?? []).length;
    expect(spawnCalls).toBeGreaterThan(0);
    expect(gates).toBeGreaterThanOrEqual(spawnCalls);
    // The chunk reader is the only filesystem read, and it must validate the relative path first.
    expect(commands).toContain('validate_relative_path');
    expect(commands).toContain('join_within');
  });

  it('keeps macOS-only code inside platform gates', () => {
    const gate = /(cfg\(target_os\s*=\s*"macos"\)|#\[cfg\(target_os\s*=\s*"macos"\)\])/;
    for (const file of rustFiles) {
      const text = code(readFileSync(file, 'utf8'));
      if (/AVFoundation|ScreenCaptureKit|CoreGraphics|objc|__bridge|capture_macos/.test(text)) {
        expect(gate.test(text), `${relative(ROOT, file)} uses Apple APIs without a target_os gate`).toBe(
          true,
        );
      }
    }
    const buildScript = readFileSync(join(DESKTOP, 'crates', 'capture-macos', 'build.rs'), 'utf8');
    expect(buildScript).toContain('cfg(target_os = "macos")');
  });

  it('keeps Windows-only code inside platform gates', () => {
    const gate = /(cfg\(target_os\s*=\s*"windows"\)|#\[cfg\(target_os\s*=\s*"windows"\)\])/;
    for (const file of rustFiles) {
      const text = code(readFileSync(file, 'utf8'));
      if (/QueryPerformanceCounter|QueryPerformanceFrequency|suhbat_win_|capture_windows/.test(text)) {
        expect(gate.test(text), `${relative(ROOT, file)} uses Windows APIs without a target_os gate`).toBe(
          true,
        );
      }
    }
    const buildScript = readFileSync(join(DESKTOP, 'crates', 'capture-windows', 'build.rs'), 'utf8');
    expect(buildScript).toContain('cfg(target_os = "windows")');
  });

  it('routes microphone and system audio to different logical sources', () => {
    const src = (...parts: string[]) =>
      readFileSync(join(DESKTOP, 'crates', 'recorder-core', 'src', ...parts), 'utf8');
    const writer = src('writer.rs');
    const session = src('session.rs');
    const manifest = src('manifest.rs');
    const errors = src('errors.rs');
    expect(session).toContain('BTreeMap<SourceKind, WriterHandle>');
    expect(writer).toContain('partial_file_name(self.spec.kind');
    expect(manifest).toContain('source_kind.directory_name()');
    expect(errors).toContain('fn directory_name');
    expect(session).not.toMatch(/fn mix_|interleave_both/);
  });

  it('never deletes a recording from disk', () => {
    // The product rule is "never lose a recording". There is no retention command in this build, so no
    // Rust file may remove a chunk, a manifest, or a session directory. Two narrow cleanups are
    // allowed, and each is proven to fire only on something that provably holds zero audio:
    //   * `writer.rs` drops a `.partial` shell that never received a single sample;
    //   * `recovery.rs` drops `.partial` shells with no decodable bytes;
    //   * `storage.rs` drops the temp file of a superseded manifest revision.
    // Anything else — and any `remove_dir_all` at all — fails the build.
    for (const file of rustFiles.filter((path) => !path.includes(`${sep}tests${sep}`))) {
      const text = code(stripTestModules(readFileSync(file, 'utf8')));
      expect(
        /remove_dir_all/.test(text),
        `${relative(ROOT, file)} removes a directory; recordings must survive until an explicit retention policy exists`,
      ).toBe(false);

      let cursor = 0;
      for (const match of text.matchAll(/remove_file/g)) {
        const before = text.slice(Math.max(0, match.index! - 700), match.index!);
        const guarded =
          /sample_count == 0 \|\| data_bytes == 0/.test(before) ||
          /manifest\.json\.tmp-/.test(before) ||
          /empty_partials|empty partial|holds no data|len <= MIN_CHUNK_BYTES/.test(before);
        expect(
          guarded,
          `${relative(ROOT, file)} removes a file without proving it holds no audio (position ${match.index!})`,
        ).toBe(true);
        cursor += 1;
      }
      expect(cursor).toBeLessThanOrEqual(1);
    }

    // Recovery's cleanup is the only place a chunk-shaped file can disappear, and it must be `.partial`.
    const recovery = code(stripTestModules(readFileSync(join(DESKTOP, 'crates', 'recorder-core', 'src', 'recovery.rs'), 'utf8')));
    const cleanup = /fn remove_empty_partials[\s\S]*?\n}/.exec(recovery)?.[0] ?? '';
    expect(cleanup, 'remove_empty_partials must exist and be the only chunk-shaped cleanup').toBeTruthy();
    // It may only ever target a `.wav.partial` shell that is too small to contain a single sample.
    expect(cleanup).toMatch(/\.wav\.partial/);
    expect(cleanup).toMatch(/MIN_CHUNK_BYTES/);
  });
});

describe('build configuration stays local', () => {
  it('has no dev-server proxy and no external asset reference', () => {
    const vite = readFileSync(join(DESKTOP, 'vite.config.ts'), 'utf8');
    expect(vite).not.toMatch(/proxy\s*:/);
    const html = readFileSync(join(DESKTOP, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)\s*=\s*["']https?:/);
  });

  it('does not expose recordings over a server: the renderer is bundled from disk', () => {
    const config = JSON.parse(
      readFileSync(join(DESKTOP, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as {
      build: { frontendDist: string };
      app: { security: { csp: string | null }; windows: { width: number; title: string }[] };
      bundle: { macOS?: { minimumSystemVersion?: string } };
    };
    expect(config.build.frontendDist).toBe('../dist');
    expect(config.app.security.csp).not.toBeNull();
    expect(config.app.security.csp).toContain("connect-src");
    // The window is an appliance, not a dashboard: it must not ship as a 1040px-wide grid.
    expect(config.app.windows[0]!.width).toBeLessThanOrEqual(560);
    expect(config.bundle.macOS?.minimumSystemVersion).toBe('13.0');
  });

  it('keeps script-src and style-src closed even though connect-src is open', () => {
    // Allowing outbound HTTPS is required; allowing remote *code* would not be.
    const csp = (
      JSON.parse(readFileSync(join(DESKTOP, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
        app: { security: { csp: string } };
      }
    ).app.security.csp;
    expect(csp).not.toMatch(/script-src\s+(?!'self')/);
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/default-src\s+\*/);
  });

  it('grants the webview no capability beyond the app commands', () => {
    const capability = JSON.parse(
      readFileSync(join(DESKTOP, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
    ) as { permissions: string[] };
    for (const permission of capability.permissions) {
      for (const forbidden of ['shell', 'fs', 'http', 'opener', 'dialog', 'global-shortcut', 'updater']) {
        expect(permission.includes(forbidden), `capability grants ${permission}`).toBe(false);
      }
    }
  });

  it('ships every config file the shell needs, referencing no remote host', () => {
    const allowedHosts = new Set(['localhost', '127.0.0.1', 'schema.tauri.app', 'www.w3.org']);
    for (const file of configFiles) {
      const label = relative(DESKTOP, file);
      expect(existsSync(file), `missing ${label}`).toBe(true);
      if (file.endsWith('.plist')) continue;
      const text = readFileSync(file, 'utf8');
      for (const url of text.matchAll(/https?:\/\/([A-Za-z0-9.\-]+)/g)) {
        expect(allowedHosts.has(url[1] ?? ''), `${label} references ${url[1]}`).toBe(true);
      }
    }
  });

  it('declares the outgoing-network entitlement the upload path needs, and nothing more', () => {
    const entitlements = readFileSync(join(DESKTOP, 'src-tauri', 'Entitlements.plist'), 'utf8');
    expect(entitlements).toContain('com.apple.security.device.audio-input');
    // Capture is local-first, but a finalized recording has to reach the server. Without this key a
    // sandboxed build cannot open a socket at all, and every meeting would silently stay local.
    expect(entitlements).toContain('com.apple.security.network.client');
    // Still no listening socket and no arbitrary file access.
    expect(entitlements).not.toContain('com.apple.security.network.server');
    expect(entitlements).not.toContain('com.apple.security.files.user-selected.read-write');
    expect(entitlements).toContain('com.apple.security.app-sandbox');
    const plist = readFileSync(join(DESKTOP, 'src-tauri', 'Info.plist'), 'utf8');
    expect(plist).toContain('NSMicrophoneUsageDescription');
    const productName = (
      JSON.parse(readFileSync(join(DESKTOP, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
        productName?: string;
      }
    ).productName;
    expect(typeof productName === 'string' && productName.length > 0).toBe(true);
  });

  it('keeps every desktop file inside the repository root', () => {
    for (const file of [...rendererFiles, ...rustFiles]) {
      expect(file.startsWith(DESKTOP + sep) || file.startsWith(DESKTOP)).toBe(true);
      expect(file).not.toContain('..');
    }
  });
});
