import { beforeEach, describe, expect, it, vi } from 'vitest';

// `repositories.ts` and `@suhbat/database/server` are server-only modules; in this Node test they carry no
// browser-component hazard, so the guard is neutralized for the import.
vi.mock('server-only', () => ({}));

import {
  getCapabilities,
  getRepositories,
  setLiveRepositoryContext,
} from '../../apps/web/src/lib/repositories';
import type {
  PostgrestQuery,
  PostgrestRows,
  PostgrestRow,
} from '../../apps/web/src/lib/supabase-live-repositories';

/**
 * Regression cover for the staging blocker:
 * `SUHBAT_DATA_MODE=live` resolved to a placeholder repository that rejected `workspaces.list` with
 * `provider_unavailable` even though the workspace existed and the user was an active owner.
 *
 * The fake below is a minimal PostgREST-shaped client: it records every query so the tests can prove the
 * adapter reads through the signed-in session (filters on `user_id` / `workspace_id`) and never serves demo
 * fixtures or a placeholder.
 */

type Row = Record<string, unknown>;

type RecordedFilter = { kind: 'eq' | 'neq' | 'in' | 'is'; column: string; value: unknown };
type RecordedQuery = { table: string; filters: RecordedFilter[] };
type RecordedCall = RecordedQuery & { columns: string; single: boolean };

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceA = '11111111-1111-4111-8111-111111111111';
const workspaceB = '22222222-2222-4222-8222-222222222222';
const meetingA = '33333333-3333-4333-8333-333333333333';
const meetingTypeA = '44444444-4444-4444-8444-444444444444';

class FakeQuery implements PostgrestQuery<Row> {
  private readonly filters: RecordedFilter[] = [];
  private readonly sorts: { column: string; ascending: boolean }[] = [];
  private max: number | null = null;
  private selected = '';

  constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly table: string,
    private readonly calls: RecordedCall[],
  ) {}

  private snapshot(): Row[] {
    const rows = (this.tables[this.table] ?? []).filter((row) =>
      this.filters.every((filter) => {
        const value = row[filter.column];
        if (filter.kind === 'eq') return value === filter.value;
        if (filter.kind === 'neq') return value !== filter.value;
        if (filter.kind === 'is') return value === filter.value;
        return Array.isArray(filter.value) && (filter.value as unknown[]).includes(value);
      }),
    );
    const sorted = [...rows];
    for (const sort of this.sorts) {
      sorted.sort((left, right) => {
        const a = String(left[sort.column] ?? '');
        const b = String(right[sort.column] ?? '');
        return sort.ascending ? a.localeCompare(b) : b.localeCompare(a);
      });
    }
    return this.max === null ? sorted : sorted.slice(0, this.max);
  }

  private record(single: boolean, columns: string): void {
    this.calls.push({
      table: this.table,
      filters: [...this.filters],
      columns,
      single,
    });
  }

  select(columns?: string): PostgrestQuery<Row> {
    this.selected = columns ?? '*';
    return this;
  }

  eq(column: string, value: unknown): PostgrestQuery<Row> {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  neq(column: string, value: unknown): PostgrestQuery<Row> {
    this.filters.push({ kind: 'neq', column, value });
    return this;
  }

  in(column: string, values: readonly unknown[]): PostgrestQuery<Row> {
    this.filters.push({ kind: 'in', column, value: [...values] });
    return this;
  }

  is(column: string, value: boolean | null): PostgrestQuery<Row> {
    this.filters.push({ kind: 'is', column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): PostgrestQuery<Row> {
    this.sorts.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): PostgrestQuery<Row> {
    this.max = count;
    return this;
  }

  then<TResult1 = PostgrestRows<Row>, TResult2 = never>(
    onfulfilled?:
      | ((value: PostgrestRows<Row>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.record(false, this.selected);
    return Promise.resolve<PostgrestRows<Row>>({ data: this.snapshot(), error: null }).then(
      onfulfilled,
      onrejected,
    );
  }

  async maybeSingle(): Promise<PostgrestRow<Row>> {
    this.record(true, this.selected);
    const rows = this.snapshot();
    if (rows.length > 1) {
      return { data: null, error: { message: 'multiple rows returned', code: 'PGRST116' } };
    }
    return { data: rows[0] ?? null, error: null };
  }
}

class FakeClient {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly tables: Record<string, Row[]>) {}

  from(table: string): PostgrestQuery<Row> {
    return new FakeQuery(this.tables, table, this.calls);
  }
}

function fixtureTables(overrides: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    workspaces: [
      { id: workspaceA, name: 'Workspace A', slug: 'workspace-a', created_at: '2026-10-01T00:00:00.000Z' },
      { id: workspaceB, name: 'Workspace B', slug: 'workspace-b', created_at: '2026-10-02T00:00:00.000Z' },
    ],
    // RLS exposes only the caller's own membership rows; the fake mirrors that by storing both users' rows
    // and by the adapter filtering on `user_id` (asserted below).
    workspace_members: [
      { workspace_id: workspaceA, user_id: userA, role: 'owner', membership_status: 'active' },
      { workspace_id: workspaceB, user_id: userB, role: 'owner', membership_status: 'active' },
    ],
    profiles: [{ id: userA, display_name: 'Owner A' }],
    meeting_types: [
      {
        id: meetingTypeA,
        workspace_id: workspaceA,
        key: 'sales',
        display_name: 'Sales call',
        template_key: null,
        sort_order: 0,
        is_active: true,
      },
    ],
    meetings: [
      {
        id: meetingA,
        workspace_id: workspaceA,
        company_id: null,
        project_id: null,
        meeting_type_id: meetingTypeA,
        title: 'Kickoff',
        status: 'draft',
        processing_status: 'idle',
        started_at: null,
        created_at: '2026-10-06T09:00:00.000Z',
        created_by: userA,
        timeline_duration_ms: null,
        active_capture_duration_ms: null,
        detected_languages: [],
        current_transcription_run_id: null,
        latest_transcription_run_id: null,
        current_analysis_run_id: null,
        latest_analysis_run_id: null,
        deleted_at: null,
        purge_status: 'active',
      },
    ],
    companies: [],
    projects: [],
    recordings: [],
    meeting_participants: [
      { id: '99999999-9999-4999-8999-999999999999', meeting_id: meetingA, workspace_id: workspaceA, user_id: userA, display_name: 'Owner A', email: null, is_external: false, sort_order: 0 },
    ],
    meeting_speakers: [],
    transcript_segments: [],
    ...overrides,
  };
}

function liveContext(tables: Record<string, Row[]> = fixtureTables()) {
  const client = new FakeClient(tables);
  setLiveRepositoryContext({ client, userId: userA });
  return client;
}

const envBackup = {
  mode: process.env.SUHBAT_DATA_MODE,
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

function restoreEnv(): void {
  if (envBackup.mode === undefined) delete process.env.SUHBAT_DATA_MODE;
  else process.env.SUHBAT_DATA_MODE = envBackup.mode;
  if (envBackup.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = envBackup.url;
  if (envBackup.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = envBackup.key;
}

beforeEach(() => {
  restoreEnv();
  setLiveRepositoryContext(null);
});

describe('live mode resolves to the session-backed Supabase adapter', () => {
  it('loads the signed-in user’s workspace instead of a placeholder repository', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    const client = liveContext();

    const repositories = getRepositories();
    const workspaces = await repositories.workspaces.list();

    expect(repositories.capabilities.mode).toBe('live');
    expect(workspaces.map((workspace) => workspace.id)).toEqual([workspaceA]);
    expect(workspaces[0]).toMatchObject({ name: 'Workspace A', role: 'owner', demo: false });

    // The read really went through the session client, scoped to the signed-in user.
    const membershipQueries = client.calls.filter((call) => call.table === 'workspace_members');
    expect(membershipQueries.length).toBeGreaterThan(0);
    for (const query of membershipQueries) {
      expect(query.filters).toContainEqual({ kind: 'eq', column: 'user_id', value: userA });
    }
  });

  it('never reports the old "not implemented yet" placeholder failure', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    liveContext();

    await expect(getRepositories().workspaces.list()).resolves.toBeTruthy();
    await expect(getRepositories().meetings.dashboard(workspaceA)).resolves.toMatchObject({
      workspaceId: workspaceA,
      meetingCount: 1,
    });

    const failure = await getRepositories()
      .settings.get(workspaceB)
      .then(
        () => null,
        (cause: unknown) => cause as { code?: string; message?: string },
      );
    expect(failure?.message ?? '').not.toContain('not implemented yet');
    expect(failure?.code).not.toBe('provider_unavailable');
  });

  it('loads the dashboard, tasks and settings for a member of the workspace', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    liveContext();

    const repositories = getRepositories();
    const [dashboard, tasks, settings] = await Promise.all([
      repositories.meetings.dashboard(workspaceA),
      repositories.tasks.list(workspaceA),
      repositories.settings.get(workspaceA),
    ]);

    expect(dashboard.meetingCount).toBe(1);
    expect(dashboard.recentMeetings[0]?.meeting.title).toBe('Kickoff');
    expect(dashboard.recentMeetings[0]?.meeting.state).toBe('draft');
    expect(tasks).toEqual([]);
    expect(settings).toMatchObject({
      workspaceId: workspaceA,
      workspaceName: 'Workspace A',
      currentRole: 'owner',
    });
    expect(settings.members.map((member) => member.personId)).toContain(userA);
  });

  it('scopes every workspace read by the workspace id the page asked for', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    const client = liveContext();

    await getRepositories().meetings.list(workspaceA);

    const meetingQueries = client.calls.filter((call) => call.table === 'meetings');
    expect(meetingQueries.length).toBeGreaterThan(0);
    for (const query of meetingQueries) {
      expect(query.filters).toContainEqual({ kind: 'eq', column: 'workspace_id', value: workspaceA });
    }
  });
});

describe('workspace isolation', () => {
  it('rejects a workspace the signed-in user is not an active member of', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    liveContext();

    for (const read of [
      getRepositories().workspaces.get(workspaceB),
      getRepositories().meetings.dashboard(workspaceB),
      getRepositories().settings.get(workspaceB),
      getRepositories().companies.list(workspaceB),
    ]) {
      await expect(read).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('rejects a workspace the user only has an inactive membership for', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    liveContext(
      fixtureTables({
        workspace_members: [
          { workspace_id: workspaceA, user_id: userA, role: 'owner', membership_status: 'disabled' },
        ],
      }),
    );

    await expect(getRepositories().workspaces.get(workspaceA)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('demo mode', () => {
  it('still serves the demo adapter, and a registered live context does not leak into it', async () => {
    delete process.env.SUHBAT_DATA_MODE;
    liveContext();

    const repositories = getRepositories();
    const workspaces = await repositories.workspaces.list();

    expect(repositories.capabilities.mode).toBe('demo');
    expect(getCapabilities().reads).toBe('demo');
    expect(workspaces.some((workspace) => workspace.demo)).toBe(true);
  });

  it('stays on the demo adapter when live mode is requested by an explicit demo flag', async () => {
    process.env.SUHBAT_DATA_MODE = 'demo';
    liveContext();

    await expect(getRepositories().workspaces.list()).resolves.toBeTruthy();
    expect(getRepositories().capabilities.mode).toBe('demo');
  });
});

describe('wiring: live mode with Supabase configured', () => {
  it('selects the session-bound adapter (read-only until a session resolves)', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    setLiveRepositoryContext(null);

    const repositories = getRepositories();
    expect(repositories.capabilities.mode).toBe('live');
    expect(repositories.capabilities.reads).toBe('live');
    expect(repositories.capabilities.writes).toBe(false);
    expect(repositories.capabilities.persistence).toBe('workspace_database');

    // Outside a request there is no cookie store, so the session cannot resolve. The failure must be an
    // explicit repository error — never the old placeholder message and never demo fixtures.
    const failure = await repositories.workspaces.list().then(
      () => null,
      (cause: unknown) => cause as { code?: string; message?: string },
    );
    expect(failure).not.toBeNull();
    expect(['unauthorized', 'provider_unavailable']).toContain(failure?.code);
    expect(failure?.message ?? '').not.toContain('not implemented yet');
    expect(failure?.message ?? '').not.toContain('demo');
  });
});

describe('missing live adapter configuration', () => {
  it('fails with an explicit configuration error instead of a placeholder or demo fallback', async () => {
    process.env.SUHBAT_DATA_MODE = 'live';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    setLiveRepositoryContext(null);

    const repositories = getRepositories();
    expect(repositories.capabilities.mode).toBe('live');

    const failure = await repositories.workspaces.list().then(
      () => null,
      (cause: unknown) => cause as { code?: string; message?: string; hint?: string },
    );
    expect(failure?.code).toBe('not_configured');
    expect(failure?.message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(failure?.message).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(failure?.message ?? '').not.toContain('not implemented yet');
  });
});
