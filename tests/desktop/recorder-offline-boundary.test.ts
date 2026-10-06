import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 2 boundary checks. The recorder must work with no network, no database, and no provider, so this
 * test reads the desktop sources and fails if any of them gained the ability to talk to something else.
 *
 * It is a static check on purpose: the strongest available guarantee in an environment where the Tauri
 * shell cannot be built. It is not a substitute for opening the app and watching the traffic — the
 * real-Mac procedure in docs/mac-recorder-acceptance.md includes a network observation step.
 */

const ROOT = join(__dirname, '..', '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');

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

const FORBIDDEN_RENDERER: Array<[string, RegExp]> = [
  ['fetch()', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /new\s+WebSocket|WebSocket\(/],
  ['EventSource', /new\s+EventSource/],
  ['sendBeacon', /navigator\.sendBeacon/],
  ['absolute http(s) URL', /["'`]https?:\/\//],
  ['localhost or 127.0.0.1', /(localhost|127\.0\.0\.1)/],
  ['Supabase client', /@supabase|createClient\s*\(/],
  ['database package', /@suhbat\/database/],
  ['provider SDKs', /\b(openai|assemblyai|deepgram|whisper|rev_ai)\b/i],
  ['env-based API base URL', /import\.meta\.env\.VITE_(API|SUPABASE|BACKEND)/],
  ['local static server', /createServer|http\.createServer/],
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
  // `upload_state`/`UploadState::Pending` are manifest fields from docs/recording.md §4 and must stay;
  // what must not exist is any code path that could upload.
  ['upload call sites', /\b(put_object|s3_key|presigned|multipart|upload_chunk|flush_upload)\b/],
  ['credential storage crates', /keyring|security-framework/],
  ['local web server crates', /\b(axum|warp|actix|rocket|tiny_http)\b/],
];

describe('desktop renderer stays offline', () => {
  it('finds the renderer and Rust sources it is supposed to cover', () => {
    expect(rendererFiles.length).toBeGreaterThanOrEqual(4);
    expect(rustFiles.length).toBeGreaterThanOrEqual(15);
  });

  for (const [label, pattern] of FORBIDDEN_RENDERER) {
    it(`renderer sources contain no ${label}`, () => {
      for (const file of rendererFiles) {
        const text = code(readFileSync(file, 'utf8'));
        expect(pattern.test(text), `${relative(ROOT, file)} mentions ${label}`).toBe(false);
      }
    });
  }

  it('imports only the shared/contracts packages and its own modules', () => {
    for (const file of rendererFiles) {
      const text = code(readFileSync(file, 'utf8'));
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        const allowed =
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier === 'react' ||
          specifier.startsWith('react/') ||
          specifier === 'react-dom/client' ||
          specifier === 'zod' ||
          specifier === '@suhbat/contracts' ||
          specifier === '@suhbat/shared';
        expect(
          allowed,
          `${relative(ROOT, file)} imports ${specifier}, which is outside the approved set`,
        ).toBe(true);
      }
    }
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
        expect(text.includes(forbidden), `${relative(ROOT, file)} depends on ${forbidden}`).toBe(
          false,
        );
      }
    }
  });

  it('keeps macOS-only code inside platform gates', () => {
    const gate = /(cfg\(target_os\s*=\s*"macos"\)|#\[cfg\(target_os\s*=\s*"macos"\)\])/;
    for (const file of rustFiles) {
      const text = code(readFileSync(file, 'utf8'));
      // Any file that *links* an Apple API must gate it, otherwise a Linux CI build breaks. Comments are
      // stripped first: prose about ScreenCaptureKit in a doc comment is not a build dependency.
      if (/AVFoundation|ScreenCaptureKit|CoreGraphics|objc|__bridge|capture_macos/.test(text)) {
        expect(
          gate.test(text),
          `${relative(ROOT, file)} uses Apple APIs without a target_os gate`,
        ).toBe(true);
      }
    }
    const buildScript = readFileSync(join(DESKTOP, 'crates', 'capture-macos', 'build.rs'), 'utf8');
    expect(buildScript).toContain('cfg(target_os = "macos")');
  });

  it('routes microphone and system audio to different logical sources', () => {
    const src = (...parts: string[]) =>
      readFileSync(join(DESKTOP, 'crates', 'recorder-core', 'src', ...parts), 'utf8');
    const writer = src('writer.rs');
    const session = src('session.rs');
    const manifest = src('manifest.rs');
    const errors = src('errors.rs');
    // One writer per source, keyed by kind: a single shared file would be permanent mixing.
    expect(session).toContain('BTreeMap<SourceKind, WriterHandle>');
    expect(writer).toContain('partial_file_name(self.spec.kind');
    expect(manifest).toContain('source_kind.directory_name()');
    expect(errors).toContain('fn directory_name');
    expect(session).not.toMatch(/fn mix_|interleave_both/);
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
      build: { frontendDist: string; devUrl?: string };
      app: { security: { csp: string | null } };
      bundle: { macOS?: { minimumSystemVersion?: string } };
    };
    expect(config.build.frontendDist).toBe('../dist');
    expect(config.app.security.csp).not.toBeNull();
    expect(config.bundle.macOS?.minimumSystemVersion).toBe('13.0');
  });

  it('grants the webview no capability beyond the app commands', () => {
    const capability = JSON.parse(
      readFileSync(join(DESKTOP, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
    ) as { permissions: string[] };
    for (const permission of capability.permissions) {
      for (const forbidden of [
        'shell',
        'fs',
        'http',
        'opener',
        'dialog',
        'global-shortcut',
        'updater',
      ]) {
        expect(permission.includes(forbidden), `capability grants ${permission}`).toBe(false);
      }
    }
  });

  it('ships every config file the shell needs, referencing no remote host', () => {
    // A config that only exists in prose is the classic way a desktop build "works on my machine"; the
    // entitlements and capability files are as load-bearing as the Rust sources.
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

  it('grants the application bundle only the microphone entitlement', () => {
    const entitlements = readFileSync(join(DESKTOP, 'src-tauri', 'Entitlements.plist'), 'utf8');
    expect(entitlements).toContain('com.apple.security.device.audio-input');
    // No network client and no user-selected file access: the recorder must not gain a route out.
    expect(entitlements).not.toContain('com.apple.security.network.client');
    expect(entitlements).not.toContain('com.apple.security.files.user-selected.read-write');
    const plist = readFileSync(join(DESKTOP, 'src-tauri', 'Info.plist'), 'utf8');
    expect(plist).toContain('NSMicrophoneUsageDescription');
    // ScreenCaptureKit needs no Info.plist key; the TCC prompt is the gate (verified in test A). The
    // product name that Tauri merges into the bundle must exist, or the usage string has no owner.
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
