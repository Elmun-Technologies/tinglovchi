import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  audioDeviceSchema,
  backendAvailabilitySchema,
  chunkRecordSchema,
  diskPreflightSchema,
  gapRecordSchema,
  markerRecordSchema,
  noteRecordSchema,
  permissionSnapshotSchema,
  recorderErrorCodeSchema,
  recorderErrorSchema,
  recorderEventSchema,
  recorderManifestSchema,
  recorderStateSchema,
  recorderStatusSchema,
  recordingSourceKindSchema,
  recoveryReportSchema,
  sourceLevelSchema,
  sourceStatusSchema,
  chunkStateSchema,
  gapReasonSchema,
  manifestStateSchema,
  permissionStateSchema,
  sourceHealthSchema,
  startRecordingRequestSchema,
  timelineOriginSchema,
} from '@suhbat/contracts';

/**
 * Cross-language contract test.
 *
 * The Rust recorder owns the bytes on disk; the renderer owns what the operator sees. Both read the same
 * names, and only one of them can be compiled in this environment. So instead of trusting a human to keep
 * them aligned, this test parses the Rust `serde` declarations out of the source text and compares them,
 * field by field and enum value by enum value, with the zod schemas in `packages/contracts`.
 *
 * It catches the two drift bugs that would actually hurt: a renamed field (the renderer silently shows
 * `undefined`) and a number that became a decimal string (the renderer throws at parse time). It does not
 * prove the Rust code compiles — see the gates in docs/mac-recorder-acceptance.md.
 */

const ROOT = join(__dirname, '..', '..');
const CORE = join(ROOT, 'apps', 'desktop', 'crates', 'recorder-core', 'src');

type RustField = { name: string; type: string; serde: string };

function sliceBlock(text: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  throw new Error('unbalanced braces while parsing Rust source');
}

/** Fields of a `pub struct Name { ... }` with the camelCase name serde would emit. */
function rustFields(file: string, structName: string): RustField[] {
  const text = readFileSync(join(CORE, file), 'utf8');
  const declaration = new RegExp(`pub\\s+struct\\s+${structName}\\b`).exec(text);
  if (!declaration) throw new Error(`${file}: no \`pub struct ${structName}\``);
  const brace = text.indexOf('{', declaration.index + declaration[0].length - 1);
  const body = sliceBlock(text, brace);
  const header = text.slice(Math.max(0, text.lastIndexOf('\n', brace) - 400), brace);
  const camelCase = /rename_all\s*=\s*"camelCase"/.test(header);
  const fields: RustField[] = [];
  const pattern =
    /#\[serde\(([^\n]*)\)\]\s*\n\s*pub\s+(\w+)\s*:\s*([^;\n]+?)(?:,|$)|pub\s+(\w+)\s*:\s*([^;\n]+?)(?:,|$)/g;
  for (const match of body.matchAll(pattern)) {
    const attributes = match[1];
    const name = match[2] ?? match[4];
    const type = (match[3] ?? match[5]).trim();
    if (!name || !type) continue;
    fields.push({
      name,
      type: type.replace(/\s+/g, ''),
      serde: attributes ?? '',
    });
  }
  return fields
    .filter((field) => !field.serde.includes('skip'))
    .map((field) => ({
      ...field,
      name:
        field.serde.match(/rename\s*=\s*"([^"]+)"/)?.[1] ??
        (camelCase ? toCamel(field.name) : field.name),
    }));
}

function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** Variant tags of a `pub enum Name { ... }`, honouring explicit `#[serde(rename = "...")]`. */
function rustEnum(
  file: string,
  enumName: string,
): { renameAll: string | null; variants: string[] } {
  const text = readFileSync(join(CORE, file), 'utf8');
  const declaration = new RegExp(`pub\\s+enum\\s+${enumName}\\b`).exec(text);
  if (!declaration) throw new Error(`${file}: no \`pub enum ${enumName}\``);
  const brace = text.indexOf('{', declaration.index + declaration[0].length - 1);
  const header = text.slice(Math.max(0, text.lastIndexOf('\n', brace) - 400), brace);
  const body = sliceBlock(text, brace);
  const renameAll = /rename_all\s*=\s*"([^"]+)"/.exec(header)?.[1] ?? null;
  const variants: string[] = [];
  const pattern =
    /#\[serde\([^)]*rename\s*=\s*"([^"]+)"[^)]*\)\]\s*\n\s*(\w+)|^\s*(\w+)\s*(?:\{|\(|,|$)/gm;
  for (const match of body.matchAll(pattern)) {
    const explicit = match[1];
    const name = match[2] ?? match[3];
    if (!name) continue;
    if (/^(pub|const|fn|impl|mut|self|use)$/.test(name)) continue;
    variants.push(explicit ?? (renameAll === 'snake_case' ? toSnake(name) : name));
  }
  return { renameAll, variants };
}

function toSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Unwrap `.nullable()`, `.optional()`, `.default(...)` to the underlying zod kind. */
function kindOf(schema: unknown): { kind: string; nullable: boolean; element?: unknown } {
  let nullable = false;
  let current = schema as { _def?: { type?: string; innerType?: unknown; type_?: unknown } };
  for (let guard = 0; guard < 8; guard += 1) {
    const type = current?._def?.type ?? 'unknown';
    if (type === 'nullable' || type === 'nullish') {
      nullable = true;
      current = current._def?.innerType as typeof current;
      continue;
    }
    if (type === 'optional' || type === 'default') {
      current = current._def?.innerType as typeof current;
      continue;
    }
    return {
      kind: type,
      nullable,
      element: current?._def?.type === 'array' ? current._def.innerType : undefined,
    };
  }
  return { kind: 'unknown', nullable };
}

function shapeOf(schema: unknown): Record<string, unknown> {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  expect(shape, 'expected an object schema here').toBeDefined();
  return shape as Record<string, unknown>;
}

/** Walk `default`/`optional`/`nullable` wrappers, then into an array's element. */
function resolve(schema: unknown): unknown {
  let current = schema as { _def?: { type?: string; innerType?: unknown; element?: unknown } };
  for (let guard = 0; guard < 10; guard += 1) {
    const type = current?._def?.type;
    if (
      type === 'default' ||
      type === 'optional' ||
      type === 'nullable' ||
      type === 'nonoptional' ||
      type === 'nullish'
    ) {
      current = current._def?.innerType as typeof current;
      continue;
    }
    if (type === 'array') {
      current = (current._def?.element ?? current._def?.innerType) as typeof current;
      continue;
    }
    return current;
  }
  return current;
}

/** `Option<Vec<T>>` and `Vec<T>` both mean "array or nothing" on the wire. */
function expectedKindFor(rustType: string): string[] {
  const type = rustType.replace(/\s+/g, '');
  if (/^DecimalU128$/.test(type)) return ['string'];
  // A pinned constant on the Rust side (`schemaVersion: u32` always 1) is legitimately a `z.literal` in the
  // contract: same JSON type, stricter check.
  if (/^(u64|u32|u16|u128|usize|i64|f32|f64)$/.test(type)) return ['number', 'literal'];
  if (/^bool$/.test(type)) return ['boolean'];
  if (/^(String|&'static\s+str)$/.test(type)) return ['string'];
  if (/^(Option|Vec|Box)/.test(type))
    return [
      'array',
      'object',
      'string',
      'number',
      'boolean',
      'union',
      'discriminatedunion',
      'lazy',
      'unknown',
    ];
  return [
    'object',
    'string',
    'number',
    'boolean',
    'array',
    'enum',
    'union',
    'discriminatedunion',
    'unknown',
    'literal',
  ];
}

const STRUCT_PAIRS: Array<[string, string, Record<string, unknown>]> = [
  ['manifest.rs', 'RecorderManifest', shapeOf(recorderManifestSchema)],
  ['manifest.rs', 'TimelineBlock', shapeOf(timelineOriginSchema)],
  ['manifest.rs', 'GapRecord', shapeOf(gapRecordSchema)],
  ['manifest.rs', 'SourceRecord', shapeOf(sourceStatusSchema)],
  ['manifest.rs', 'ChunkRecord', shapeOf(chunkRecordSchema)],
  ['manifest.rs', 'MarkerRecord', shapeOf(markerRecordSchema)],
  ['manifest.rs', 'NoteRecord', shapeOf(noteRecordSchema)],
  ['session.rs', 'RecorderStatus', shapeOf(recorderStatusSchema)],
  ['session.rs', 'DiskState', shapeOf(diskPreflightSchema)],
  ['platform.rs', 'PermissionSnapshot', shapeOf(permissionSnapshotSchema)],
  ['platform.rs', 'AudioDevice', shapeOf(audioDeviceSchema)],
  ['errors.rs', 'RecorderError', shapeOf(recorderErrorSchema)],
  ['session.rs', 'StartRequest', shapeOf(startRecordingRequestSchema)],
];

const ENUM_PAIRS: Array<[string, string, { options: readonly string[] }]> = [
  ['state.rs', 'RecorderState', recorderStateSchema],
  ['manifest.rs', 'ManifestState', manifestStateSchema],
  ['manifest.rs', 'SourceHealth', sourceHealthSchema],
  ['manifest.rs', 'ChunkState', chunkStateSchema],
  ['timeline.rs', 'GapReason', gapReasonSchema],
  ['errors.rs', 'SourceKind', recordingSourceKindSchema],
  ['platform.rs', 'PermissionState', permissionStateSchema],
  ['errors.rs', 'RecorderErrorCode', recorderErrorCodeSchema],
  ['capture.rs', 'BackendAvailability', backendAvailabilitySchema],
];

describe('Rust recorder and the shared contracts agree field by field', () => {
  it('parses the Rust structs it claims to cover', () => {
    const manifest = rustFields('manifest.rs', 'RecorderManifest');
    expect(manifest.length).toBeGreaterThan(10);
    expect(manifest.map((field) => field.name)).toContain('schemaVersion');
    // Renames and flattened maps must be understood, or the comparison below would be meaningless.
    expect(manifest.some((field) => field.name === 'lastUpdatedAt')).toBe(true);
  });

  for (const [file, structName, shape] of STRUCT_PAIRS) {
    it(`${structName} fields match ${Object.keys(shape).length} contract keys`, () => {
      const fields = rustFields(file, structName).filter(
        (field) => !field.serde.includes('flatten'),
      );
      const rustNames = fields.map((field) => field.name);
      for (const name of rustNames) {
        expect(shape[name], `contract is missing ${structName}.${name}`).toBeDefined();
      }
      // The contract may declare extra keys only when they are optional or nullish on the wire, which is
      // how `RecorderError` carries `sourceKind`/`openSettingsUrl` without forcing Rust to emit them.
      const extras = Object.keys(shape).filter((name) => !rustNames.includes(name));
      for (const name of extras) {
        const { nullable, kind } = kindOf(shape[name]);
        expect(
          nullable || kind === 'optional',
          `${structName}.${name} exists only in the contract: Rust never writes it`,
        ).toBe(true);
      }
      for (const field of fields) {
        const schema = shape[field.name];
        expect(schema, `contract is missing ${structName}.${field.name}`).toBeDefined();
        const { kind, nullable } = kindOf(schema);
        const expected = expectedKindFor(field.type);
        expect(
          expected.includes(kind) || (field.type.startsWith('Option<') && nullable),
          `${structName}.${field.name}: Rust ${field.type} vs contract kind "${kind}"`,
        ).toBe(true);
        if (field.type === 'DecimalU128') {
          expect(
            kind,
            `${structName}.${field.name} must be a decimal string, not a JSON number`,
          ).toBe('string');
        }
        if (/^(u64|u32|u16)$/.test(field.type)) {
          expect(
            ['number', 'enum', 'literal'].includes(kind),
            `${structName}.${field.name} must be a JSON number`,
          ).toBeTruthy();
        }
      }
    });
  }

  it('SourceLevel is flattened, so the meter keys live at one level', () => {
    const levelKeys = Object.keys(shapeOf(sourceLevelSchema)).sort();
    expect(levelKeys).toEqual(
      [
        'kind',
        'meetingMs',
        'peak',
        'rms',
        'peakDbfs',
        'clippingSamples',
        'blockSampleCount',
        'live',
      ].sort(),
    );
    const sessionText = readFileSync(join(CORE, 'session.rs'), 'utf8');
    expect(sessionText).toContain('#[serde(flatten)]');
  });

  it('the manifest interval and consent/storage blocks match too', () => {
    const manifestShape = shapeOf(recorderManifestSchema);
    const intervals = shapeOf(resolve(manifestShape.activeIntervals));
    const rustInterval = rustFields('manifest.rs', 'ActiveIntervalRecord')
      .map((field) => field.name)
      .sort();
    expect(Object.keys(intervals).sort()).toEqual(rustInterval);

    const consent = shapeOf(manifestShape.consent);
    expect(Object.keys(consent).sort()).toEqual(
      rustFields('manifest.rs', 'ConsentRecord')
        .map((field) => field.name)
        .sort(),
    );
    const storage = shapeOf(manifestShape.storage);
    expect(Object.keys(storage).sort()).toEqual(
      rustFields('manifest.rs', 'StorageRecord')
        .map((field) => field.name)
        .sort(),
    );
    const marker = shapeOf(resolve(manifestShape.markers));
    expect(Object.keys(marker).sort()).toEqual(
      rustFields('manifest.rs', 'MarkerRecord')
        .map((field) => field.name)
        .sort(),
    );
  });

  for (const [file, enumName, schema] of ENUM_PAIRS) {
    it(`${enumName} has exactly the contract values`, () => {
      const { variants } = rustEnum(file, enumName);
      const contract = [...schema.options].sort();
      // Only the variants without payload are wire values; every recorder enum is fieldless.
      expect(variants.length, `${enumName}: parsed variants ${variants.join(',')}`).toBeGreaterThan(
        0,
      );
      expect([...new Set(variants)].sort()).toEqual(contract);
    });
  }

  it('the single-value enums the manifest pins stay single-value', () => {
    expect(rustEnum('manifest.rs', 'Codec').variants).toEqual(['pcm_s16le']);
    expect(rustEnum('manifest.rs', 'Container').variants).toEqual(['wav']);
    expect(rustEnum('manifest.rs', 'UploadState').variants).toEqual(['pending']);
    expect(rustEnum('manifest.rs', 'VerificationState').variants).toEqual(['pending']);
    expect(rustEnum('manifest.rs', 'CaptureFormat').variants).toEqual(['wav_pcm_s16le']);
    expect(rustEnum('manifest.rs', 'NoteKind').variants).toEqual(['manual']);
    expect(rustEnum('manifest.rs', 'SourceRole').variants).toEqual(['original']);
  });

  it('the event union covers every RecorderEvent variant', () => {
    const { variants } = rustEnum('session.rs', 'RecorderEvent');
    const rustTags = variants
      .map((variant) => variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
      .sort();
    expect(rustTags).toEqual(
      [
        'state',
        'permissions',
        'levels',
        'chunk_finalized',
        'annotation',
        'recovery',
        'fault',
      ].sort(),
    );
  });

  it('the event union carries every recorder event plus the one the desktop shell emits', () => {
    //
    // `RecorderEvent` is recorder-core's own vocabulary. The Tauri shell adds exactly one more —
    // `close_requested`, raised by `emit_close_requested` when the user hits the window close button
    // during capture — so the renderer can ask before the OS takes the session away. It has no Rust
    // enum variant to compare against, which is why it is asserted here rather than above.
    const { variants } = rustEnum('session.rs', 'RecorderEvent');
    const tags = recorderEventSchema.options
      .map((option) => {
        const literal = shapeOf(option).type as { _def?: { values?: unknown[]; value?: unknown } };
        return literal?._def?.values?.[0] ?? literal?._def?.value;
      })
      .filter((tag): tag is string => typeof tag === 'string')
      .sort();
    const rustTags = variants
      .map((variant) => variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
      .sort();
    expect(tags).toEqual([...rustTags, 'close_requested'].sort());

    const shell = readFileSync(join(ROOT, 'apps/desktop/src-tauri/src/state.rs'), 'utf8');
    expect(shell).toMatch(/fn emit_close_requested/);
    expect(shell).toMatch(/"closeRequested"|close_requested/);
  });

  it('recovery report fields match, including the added recoverable verdict', () => {
    const reportShape = shapeOf(recoveryReportSchema);
    expect(Object.keys(reportShape).sort()).toEqual(['rejected', 'scannedAt', 'sessions']);
    const sessionShape = shapeOf(resolve(reportShape.sessions));
    const rust = rustFields('recovery.rs', 'RecoveredSession').map((field) => field.name);
    for (const name of rust) {
      expect(sessionShape[name], `session summary is missing ${name}`).toBeDefined();
    }
    expect(Object.keys(sessionShape).length).toBeGreaterThanOrEqual(rust.length);
    expect(sessionShape.recoverable).toBeDefined();
    const rejectedShape = shapeOf(resolve(reportShape.rejected));
    expect(Object.keys(rejectedShape).sort()).toEqual(
      rustFields('recovery.rs', 'RejectedSession')
        .map((field) => field.name)
        .sort(),
    );
  });
});
