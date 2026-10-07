import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The session-bound dashboard adapter talks to PostgreSQL through PostgREST, so a column that does not exist
 * is not a type error — it is a 400 at runtime, on staging, in front of a user. This test pins the adapter to
 * the real schema: every table it reads, and every column it selects, filters or orders by, must exist in
 * `supabase/migrations`.
 *
 * It reads the migrations the same way they are applied: `create table` plus later `alter table ... add column`.
 */

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const adapterPath = join(process.cwd(), 'apps', 'web', 'src', 'lib', 'supabase-live-repositories.ts');

function migrationSql(): string {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), 'utf8'))
    .join('\n');
}

/** Constraint and table-clause keywords that start a line inside `create table (...)` but are not columns. */
const nonColumnKeywords = new Set([
  'primary',
  'unique',
  'constraint',
  'foreign',
  'check',
  'references',
  'exclude',
  'like',
]);

function schemaColumns(): Map<string, Set<string>> {
  const sql = migrationSql();
  const tables = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    const columns = tables.get(table) ?? new Set<string>();
    columns.add(column);
    tables.set(table, columns);
  };

  for (const match of sql.matchAll(/create table (?:if not exists )?public\.([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
    const [, table, body] = match;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;
      const column = /^([a-z_][a-z0-9_]*)/.exec(line)?.[1];
      if (!column || nonColumnKeywords.has(column)) continue;
      add(table, column);
    }
  }

  for (const match of sql.matchAll(/alter table (?:if exists )?public\.([a-z_]+)([\s\S]*?);/gi)) {
    const [, table, body] = match;
    for (const column of body.matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*)/gi)) {
      add(table, column[1]);
    }
  }

  return tables;
}

type AdapterRead = { table: string; columns: string[]; operation: string };

function adapterReads(): AdapterRead[] {
  const source = readFileSync(adapterPath, 'utf8');
  const reads: AdapterRead[] = [];
  const sites = [...source.matchAll(/from\('([a-z_]+)'\)/g)];

  sites.forEach((site, index) => {
    const start = (site.index ?? 0) + site[0].length;
    const end = index + 1 < sites.length ? (sites[index + 1].index ?? source.length) : source.length;
    const window = source.slice(start, end);
    for (const select of window.matchAll(/\.select\(\s*'([^']*)'/g)) {
      const columns = select[1]
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column && column !== '*');
      reads.push({ table: site[1], columns, operation: 'select' });
    }
    for (const filter of window.matchAll(/\.(eq|neq|is|in|order)\(\s*'([a-z_]+)'/g)) {
      reads.push({ table: site[1], columns: [filter[2]], operation: filter[1] });
    }
  });

  return reads;
}

describe('session-bound live adapter against the migrated schema', () => {
  const tables = schemaColumns();
  const reads = adapterReads();

  it('reads at least one table, and the migrations were parsed', () => {
    expect(tables.size).toBeGreaterThan(30);
    expect(reads.length).toBeGreaterThan(20);
  });

  it('only reads tables that the migrations create', () => {
    const unknown = [...new Set(reads.map((read) => read.table))].filter(
      (table) => !tables.has(table),
    );
    expect(unknown).toEqual([]);
  });

  it('only selects and filters columns that the migrations define', () => {
    const missing = reads
      .filter((read) => !read.columns.every((column) => tables.get(read.table)?.has(column)))
      .map(
        (read) =>
          `${read.table}.${read.columns.filter((column) => !tables.get(read.table)?.has(column)).join(',')} (${read.operation})`,
      );
    expect([...new Set(missing)]).toEqual([]);
  });

  it('never reads the service-role-only or worker-only tables', () => {
    const tablesRead = [...new Set(reads.map((read) => read.table))];
    for (const forbidden of ['processing_jobs', 'processing_events', 'audit_logs']) {
      expect(tablesRead).not.toContain(forbidden);
    }
  });
});
