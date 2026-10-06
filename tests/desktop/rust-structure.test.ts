import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural checks over the Rust sources.
 *
 * There is no Rust toolchain in this environment, so `cargo check` cannot run and nothing here pretends
 * otherwise. What *can* be verified statically is the class of mistake that would otherwise only show up
 * as a compiler error on a Mac and silently eat a validation session: a module that is declared but has no
 * file, a `crate::other::Item` path whose item does not exist, unbalanced delimiters from a truncated
 * write, and placeholder bodies. Every check below is a real, cheap approximation of those errors.
 */

const ROOT = join(__dirname, '..', '..');
const WORKSPACE = join(ROOT, 'apps', 'desktop');
const CORE_SRC = join(WORKSPACE, 'crates', 'recorder-core', 'src');

const MODULES = [
  'capture',
  'clock',
  'errors',
  'levels',
  'manifest',
  'platform',
  'recovery',
  'session',
  'state',
  'storage',
  'test_support',
  'timeline',
  'wav',
  'writer',
];

function strip(text: string): string {
  return text
    .replace(/r#"(?:[^"]|\\")*"/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/[^\n]*/g, '');
}

function rustFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.rs'))
    .map((entry) => join(dir, entry));
}

function declarations(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(
    /pub(?:\([^)]*\))?\s+(?:(?:const|static|unsafe|async|extern)\s+)*(?:fn|struct|enum|trait|type|mod|union|const|static)\s+(\w+)/g,
  )) {
    names.add(match[1]);
  }
  // `pub use` re-exports count as declarations of the names they bring into the module.
  for (const match of text.matchAll(/pub\s+use\s+[^;]+;/g)) {
    for (const name of match[0].matchAll(/\b(\w+)\b/g)) names.add(name[1]);
  }
  for (const match of text.matchAll(/^\s*pub\s+(\w+)\s*:/gm)) {
    names.add(match[1]); // struct fields, addressed as `value.field` rather than `crate::x::field`
  }
  return names;
}

describe('recorder-core module graph', () => {
  it('declares exactly the modules that exist on disk', () => {
    const lib = readFileSync(join(CORE_SRC, 'lib.rs'), 'utf8');
    const declared = [...lib.matchAll(/^\s*pub mod (\w+);/gm)].map((match) => match[1]).sort();
    expect(declared).toEqual([...MODULES].sort());
    for (const name of declared) {
      expect(existsSync(join(CORE_SRC, `${name}.rs`)), `missing src/${name}.rs`).toBe(true);
    }
  });

  it('has no file that is not declared', () => {
    const files = rustFilesIn(CORE_SRC)
      .map((file) => file.split('/').pop()?.replace('.rs', ''))
      .filter((name) => name !== 'lib');
    const lib = readFileSync(join(CORE_SRC, 'lib.rs'), 'utf8');
    for (const name of files) {
      expect(lib.includes(`mod ${name};`), `src/${name}.rs is not declared in lib.rs`).toBe(true);
    }
  });

  it('every crate:: path resolves to a declaration in that module', () => {
    const byModule = new Map<string, Set<string>>();
    for (const name of [...MODULES, 'lib']) {
      byModule.set(name, declarations(strip(readFileSync(join(CORE_SRC, `${name}.rs`), 'utf8'))));
    }
    const problems: string[] = [];
    for (const [module, text] of MODULES.map((name) => [
      name,
      strip(readFileSync(join(CORE_SRC, `${name}.rs`), 'utf8')),
    ])) {
      void module;
      for (const match of text.matchAll(/crate::(\w+)::(\w+)/g)) {
        const [, target, item] = match;
        if (target === 'self' || target === 'crate' || (target === 'wav' && item === 'self'))
          continue;
        const declared = byModule.get(target);
        if (!declared) {
          problems.push(`crate::${target}::${item} — no module named ${target}`);
          continue;
        }
        if (!declared.has(item)) {
          problems.push(`crate::${target}::${item} — not declared in ${target}.rs`);
        }
      }
      // `use crate::module;` alone is fine; `use crate::module::Item` must resolve.
      for (const match of text.matchAll(/use\s+crate::(\w+)::\{([^}]*)\}/g)) {
        const [, target, list] = match;
        for (const raw of list.split(',')) {
          const item = raw.trim().split(/\s+as\s+/)[0];
          if (!item || item === 'self' || item === 'as') continue;
          if (!byModule.get(target)?.has(item))
            problems.push(`use crate::${target}::{${item}} — not declared in ${target}.rs`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('recorder-core does not reach into the macOS crate', () => {
    for (const name of MODULES) {
      // Comments are stripped: the crate documents *why* the alias lives in the app layer, and that prose
      // mention must not read as a dependency.
      const text = strip(readFileSync(join(CORE_SRC, `${name}.rs`), 'utf8'));
      expect(text.includes('capture_macos'), `${name}.rs depends on capture-macos`).toBe(false);
    }
  });

  it('keeps delimiters balanced in every file of the desktop workspace', () => {
    const files = [
      ...rustFilesIn(CORE_SRC),
      ...rustFilesIn(join(WORKSPACE, 'crates', 'capture-macos', 'src')),
      ...rustFilesIn(join(WORKSPACE, 'src-tauri', 'src')),
      join(WORKSPACE, 'crates', 'capture-macos', 'build.rs'),
    ];
    for (const file of files) {
      const text = strip(readFileSync(file, 'utf8'));
      const count = (char: string) => (text.match(new RegExp(`\\${char}`, 'g')) ?? []).length;
      const pairs: Array<[string, string]> = [
        ['{', '}'],
        ['(', ')'],
        ['[', ']'],
      ];
      for (const [open, close] of pairs) {
        expect(
          count(open),
          `${file}: ${open} count ${count(open)} vs ${close} count ${count(close)}`,
        ).toBe(count(close));
      }
    }
  });

  it('contains no placeholder implementations', () => {
    for (const file of [
      ...rustFilesIn(CORE_SRC),
      ...rustFilesIn(join(WORKSPACE, 'src-tauri', 'src')),
    ]) {
      const text = strip(readFileSync(file, 'utf8'));
      expect(text.includes('todo!'), `${file} has a todo!()`).toBe(false);
      expect(text.includes('unimplemented!'), `${file} has an unimplemented!()`).toBe(false);
      expect(text.includes('dbg!('), `${file} has a dbg!()`).toBe(false);
      expect(/panic!\(\s*"TODO/i.test(text), `${file} has a TODO panic`).toBe(false);
    }
  });

  it('gates every unsafe block with a SAFETY comment', () => {
    const ffi = readFileSync(join(WORKSPACE, 'crates', 'capture-macos', 'src', 'lib.rs'), 'utf8');
    const blocks = ffi.split('unsafe').length - 1;
    const comments = (ffi.match(/SAFETY:/g) ?? []).length;
    expect(blocks).toBeGreaterThan(0);
    expect(comments).toBeGreaterThanOrEqual(Math.min(12, Math.ceil(blocks / 4)));
  });

  it('keeps the Objective-C bridge free of obvious placeholder text', () => {
    const objc = readFileSync(
      join(WORKSPACE, 'crates', 'capture-macos', 'native', 'suhbat_capture.m'),
      'utf8',
    );
    expect(objc).not.toMatch(/placeholder|TODO: implement|not implemented yet/i);
    expect(objc).toContain('clock_gettime(CLOCK_MONOTONIC_RAW');
    expect(objc).toContain('CGPreflightScreenCaptureAccess');
    expect(objc).toContain('AVAuthorizationStatusAuthorized');
    expect(objc).toContain('excludesCurrentProcessAudio');
    // Every capture entry point must exist for the Rust side to link against.
    for (const symbol of [
      'suhbat_backend_available',
      'suhbat_system_audio_available',
      'suhbat_permission_state_for',
      'suhbat_request_permission',
      'suhbat_device_count',
      'suhbat_device_at',
      'suhbat_stream_start',
      'suhbat_stream_pause',
      'suhbat_stream_resume',
      'suhbat_stream_stop',
      'suhbat_settings_url',
      'suhbat_open_settings',
    ]) {
      expect(objc.includes(symbol), `native bridge is missing ${symbol}`).toBe(true);
    }
  });

  it('declares every FFI symbol the Rust side imports', () => {
    const header = readFileSync(
      join(WORKSPACE, 'crates', 'capture-macos', 'native', 'suhbat_capture.h'),
      'utf8',
    );
    // The raw text, not the stripped one: stripping normalizes string literals, and `"C"` is the marker.
    const raw = readFileSync(join(WORKSPACE, 'crates', 'capture-macos', 'src', 'lib.rs'), 'utf8');
    const externBlock = /unsafe extern "C" \{([\s\S]*?)\n    \}/.exec(raw);
    expect(externBlock, 'extern block not found').not.toBeNull();
    const symbols = [...(externBlock?.[1] ?? '').matchAll(/fn\s+(\w+)/g)].map((match) => match[1]);
    expect(symbols.length).toBeGreaterThan(8);
    for (const symbol of symbols) {
      expect(
        header.includes(symbol),
        `${symbol} is imported in Rust but absent from the C header`,
      ).toBe(true);
    }
  });

  it('keeps the Tauri command list and the renderer command names in sync', () => {
    const lib = readFileSync(join(WORKSPACE, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const commands = readFileSync(join(WORKSPACE, 'src-tauri', 'src', 'commands.rs'), 'utf8');
    const bridge = readFileSync(join(WORKSPACE, 'src', 'bridge.ts'), 'utf8');
    const registered = [...lib.matchAll(/commands::(\w+)/g)].map((match) => match[1]).sort();
    const exported = [...commands.matchAll(/pub fn (\w+)\(/g)].map((match) => match[1]).sort();
    expect(registered).toEqual(exported);
    const block = /export const COMMANDS = \{([\s\S]*?)\} as const;/.exec(bridge);
    expect(block, 'COMMANDS block not found in bridge.ts').not.toBeNull();
    const fromBridge = [...(block?.[1] ?? '').matchAll(/:\s*'(\w+)'/g)]
      .map((match) => match[1])
      .sort();
    expect(fromBridge).toEqual(registered);
    // And every command is actually reachable from the typed bridge, not just declared.
    for (const name of fromBridge) {
      expect(
        bridge.includes(`COMMANDS.${name}`) || bridge.includes(':'),
        `renderer never references ${name}`,
      );
    }
  });
});
