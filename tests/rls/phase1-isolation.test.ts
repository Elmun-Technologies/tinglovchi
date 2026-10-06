import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userAdmin = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const userMember = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const migrationPath = resolve('supabase/migrations/202610060001_phase1_foundation.sql');
const seedPath = resolve('supabase/seed.sql');

const authBootstrap = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text unique,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create function auth.uid()
  returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

type WorkspaceRows = { workspace_id: string };
type IdRow = { id: string };

let db: PGlite;

async function asUser<T>(userId: string, callback: () => Promise<T>): Promise<T> {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec('set role authenticated');
  try {
    return await callback();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createWorkspace(userId: string, name: string, slug: string): Promise<string> {
  return asUser(userId, async () => {
    const result = await db.query<WorkspaceRows>(
      'select public.create_workspace($1, $2) as workspace_id',
      [name, slug],
    );
    return result.rows[0].workspace_id;
  });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(authBootstrap);
  await db.exec(readFileSync(migrationPath, 'utf8'));
  await db.exec(readFileSync(seedPath, 'utf8'));
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values ($1, 'owner-a@example.test', '{"full_name":"Workspace Owner A"}'::jsonb),
            ($2, 'owner-b@example.test', '{"full_name":"Workspace Owner B"}'::jsonb),
            ($3, 'admin@example.test', '{"full_name":"Workspace Admin"}'::jsonb),
            ($4, 'member@example.test', '{"full_name":"Workspace Member"}'::jsonb)`,
    [userA, userB, userAdmin, userMember],
  );
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('Phase 1 PostgreSQL RLS and tenant constraints', () => {
  it('creates the first owner and default meeting types atomically', async () => {
    const workspaceId = await createWorkspace(userA, 'Alpha Workspace', 'alpha-workspace');

    await asUser(userA, async () => {
      const membership = await db.query<{ role: string; membership_status: string }>(
        'select role::text, membership_status::text from public.workspace_members where workspace_id = $1',
        [workspaceId],
      );
      expect(membership.rows).toEqual([{ role: 'owner', membership_status: 'active' }]);

      const profile = await db.query<{ display_name: string | null }>(
        'select display_name from public.profiles where id = $1',
        [userA],
      );
      expect(profile.rows[0].display_name).toBe('Workspace Owner A');

      const types = await db.query<{ key: string }>(
        'select key from public.meeting_types where workspace_id = $1 order by sort_order',
        [workspaceId],
      );
      expect(types.rows.map((row) => row.key)).toEqual([
        'general',
        'client_sales',
        'marketing',
        'internal',
        'brainstorm',
        'project_planning',
        'interview',
      ]);
    });
  });

  it('grants execute only where an operation requires it', async () => {
    const privileges = await db.query<{ role: string; func: string; can_execute: boolean }>(
      `select r.rolname as role, f.proname as func,
              pg_catalog.has_function_privilege(r.oid, f.oid, 'execute') as can_execute
         from pg_catalog.pg_proc f
         join pg_catalog.pg_namespace n on n.oid = f.pronamespace
         cross join pg_catalog.pg_roles r
        where n.nspname = 'public'
          and f.proname in ('set_updated_at', 'validate_meeting_project_company',
                            'write_workspace_audit_log', 'create_workspace')
          and r.rolname in ('anon', 'authenticated')
        order by f.proname, r.rolname`,
    );
    expect(privileges.rows.map((row) => `${row.func}:${row.role}:${row.can_execute}`)).toEqual([
      'create_workspace:anon:false',
      'create_workspace:authenticated:true',
      'set_updated_at:anon:false',
      'set_updated_at:authenticated:true',
      'validate_meeting_project_company:anon:false',
      'validate_meeting_project_company:authenticated:true',
      'write_workspace_audit_log:anon:false',
      'write_workspace_audit_log:authenticated:true',
    ]);
  });

  it('keeps meeting and meeting-type schema limited to the Phase 1 foundation', async () => {
    const meetingColumns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'meetings'
       order by ordinal_position`,
    );
    expect(meetingColumns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'workspace_id',
      'company_id',
      'project_id',
      'meeting_type_id',
      'title',
      'status',
      'created_by',
      'created_at',
      'updated_at',
    ]);

    const futureColumns = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'
         and table_name in ('meeting_type_templates', 'meeting_types')
         and column_name = 'analysis_profile_key'`,
    );
    expect(futureColumns.rows).toEqual([]);

    const lifecycle = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_catalog.pg_enum e
       join pg_catalog.pg_type t on t.oid = e.enumtypid
       where t.typname = 'meeting_status'
       order by e.enumsortorder`,
    );
    expect(lifecycle.rows).toEqual([{ enumlabel: 'draft' }]);

    const pipelineEnums = await db.query<{ typname: string }>(
      `select typname from pg_catalog.pg_type
       where typname in ('meeting_processing_status', 'subprocess_status')`,
    );
    expect(pipelineEnums.rows).toEqual([]);
  });

  it('allows owners and admins to manage companies/projects while members only read and draft meetings', async () => {
    const workspaceId = await createWorkspace(userA, 'Role policy', 'role-policy');
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
       values ($1, $2, 'admin', 'active'), ($1, $3, 'member', 'active')`,
      [workspaceId, userAdmin, userMember],
    );

    const adminRecords = await asUser(userAdmin, async () => {
      const company = await db.query<IdRow>(
        `insert into public.companies (workspace_id, name, created_by)
         values ($1, 'Admin company', $2) returning id`,
        [workspaceId, userAdmin],
      );
      const companyUpdate = await db.query<IdRow>(
        'update public.companies set name = $1 where id = $2 returning id',
        ['Admin company updated', company.rows[0].id],
      );
      const project = await db.query<IdRow>(
        `insert into public.projects (workspace_id, company_id, name, created_by)
         values ($1, $2, 'Admin project', $3) returning id`,
        [workspaceId, company.rows[0].id, userAdmin],
      );
      const projectUpdate = await db.query<IdRow>(
        'update public.projects set name = $1 where id = $2 returning id',
        ['Admin project updated', project.rows[0].id],
      );
      expect(companyUpdate.rows).toHaveLength(1);
      expect(projectUpdate.rows).toHaveLength(1);
      return { companyId: company.rows[0].id, projectId: project.rows[0].id };
    });

    await asUser(userMember, async () => {
      const visibleCompanies = await db.query<IdRow>(
        'select id from public.companies where id = $1',
        [adminRecords.companyId],
      );
      const visibleProjects = await db.query<IdRow>(
        'select id from public.projects where id = $1',
        [adminRecords.projectId],
      );
      expect(visibleCompanies.rows).toHaveLength(1);
      expect(visibleProjects.rows).toHaveLength(1);

      await expect(
        db.query(
          `insert into public.companies (workspace_id, name, created_by)
           values ($1, 'Member company', $2)`,
          [workspaceId, userMember],
        ),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        db.query(
          `insert into public.projects (workspace_id, name, created_by)
           values ($1, 'Member project', $2)`,
          [workspaceId, userMember],
        ),
      ).rejects.toThrow(/row-level security/i);

      const attemptedCompanyUpdate = await db.query<IdRow>(
        'update public.companies set name = $1 where id = $2 returning id',
        ['Member rename', adminRecords.companyId],
      );
      const attemptedProjectUpdate = await db.query<IdRow>(
        'update public.projects set name = $1 where id = $2 returning id',
        ['Member rename', adminRecords.projectId],
      );
      expect(attemptedCompanyUpdate.rows).toHaveLength(0);
      expect(attemptedProjectUpdate.rows).toHaveLength(0);

      const meetingType = await db.query<IdRow>(
        `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
        [workspaceId],
      );
      const draft = await db.query<{ status: string }>(
        `insert into public.meetings (workspace_id, meeting_type_id, title, created_by)
         values ($1, $2, 'Member draft', $3) returning status::text`,
        [workspaceId, meetingType.rows[0].id, userMember],
      );
      expect(draft.rows).toEqual([{ status: 'draft' }]);
    });
  });

  it('does not expose another workspace through direct, joined, or membership reads', async () => {
    const workspaceA = await createWorkspace(userA, 'Alpha', 'alpha');
    const workspaceB = await createWorkspace(userB, 'Beta', 'beta');

    const records = await asUser(userA, async () => {
      const company = await db.query<IdRow>(
        `insert into public.companies (workspace_id, name, created_by)
         values ($1, 'Alpha Company', $2) returning id`,
        [workspaceA, userA],
      );
      const project = await db.query<IdRow>(
        `insert into public.projects (workspace_id, company_id, name, created_by)
         values ($1, $2, 'Alpha Project', $3) returning id`,
        [workspaceA, company.rows[0].id, userA],
      );
      const meetingType = await db.query<IdRow>(
        `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
        [workspaceA],
      );
      const meeting = await db.query<IdRow>(
        `insert into public.meetings
          (workspace_id, company_id, project_id, meeting_type_id, title, created_by)
         values ($1, $2, $3, $4, 'Alpha planning', $5) returning id`,
        [workspaceA, company.rows[0].id, project.rows[0].id, meetingType.rows[0].id, userA],
      );
      return {
        companyId: company.rows[0].id,
        projectId: project.rows[0].id,
        meetingId: meeting.rows[0].id,
      };
    });

    await asUser(userB, async () => {
      const company = await db.query('select id from public.companies where id = $1', [
        records.companyId,
      ]);
      const project = await db.query('select id from public.projects where id = $1', [
        records.projectId,
      ]);
      const meeting = await db.query('select id from public.meetings where id = $1', [
        records.meetingId,
      ]);
      const joined = await db.query(
        `select m.id
           from public.meetings m
           join public.companies c on c.id = m.company_id and c.workspace_id = m.workspace_id
          where m.id = $1`,
        [records.meetingId],
      );
      const memberships = await db.query(
        'select workspace_id from public.workspace_members where workspace_id = $1',
        [workspaceA],
      );
      const attemptedUpdate = await db.query(
        'update public.companies set name = $1 where id = $2 returning id',
        ['Unauthorized rename', records.companyId],
      );
      expect(attemptedUpdate.rows).toHaveLength(0);
      await expect(
        db.query('delete from public.companies where id = $1', [records.companyId]),
      ).rejects.toThrow(/permission denied/i);
      expect(company.rows).toHaveLength(0);
      expect(project.rows).toHaveLength(0);
      expect(meeting.rows).toHaveLength(0);
      expect(joined.rows).toHaveLength(0);
      expect(memberships.rows).toHaveLength(0);

      const ownWorkspaces = await db.query<{ id: string }>(
        `select w.id from public.workspaces w
         join public.workspace_members wm on wm.workspace_id = w.id
         where wm.user_id = $1 and wm.membership_status = 'active'`,
        [userB],
      );
      expect(ownWorkspaces.rows.map((row) => row.id)).toEqual([workspaceB]);
      await expect(db.query('select * from public.audit_logs')).rejects.toThrow(
        /permission denied/i,
      );
    });

    const auditRows = await db.query<{ target_type: string; action: string }>(
      `select target_type, action from public.audit_logs
       where workspace_id = $1 order by created_at`,
      [workspaceA],
    );
    expect(
      auditRows.rows.map((row) => `${row.target_type}.${row.action.split('.').at(-1)}`),
    ).toEqual([
      'workspaces.insert',
      'workspace_members.insert',
      'companies.insert',
      'projects.insert',
      'meetings.insert',
    ]);
  });

  it('rejects forged cross-workspace inserts and mismatched project/company references', async () => {
    const workspaceA = await createWorkspace(userA, 'North', 'north');
    const workspaceB = await createWorkspace(userB, 'South', 'south');

    const companyB = await asUser(userB, async () => {
      const result = await db.query<IdRow>(
        `insert into public.companies (workspace_id, name, created_by)
         values ($1, 'South Company', $2) returning id`,
        [workspaceB, userB],
      );
      return result.rows[0].id;
    });

    const projectB = await asUser(userB, async () => {
      const result = await db.query<IdRow>(
        `insert into public.projects (workspace_id, company_id, name, created_by)
         values ($1, $2, 'South Project', $3) returning id`,
        [workspaceB, companyB, userB],
      );
      return result.rows[0].id;
    });

    await asUser(userA, async () => {
      await expect(
        db.query(
          `insert into public.companies (workspace_id, name, created_by)
           values ($1, 'Forged', $2)`,
          [workspaceB, userA],
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);

      const ownType = await db.query<IdRow>(
        `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
        [workspaceA],
      );
      await expect(
        db.query(
          `insert into public.meetings
            (workspace_id, company_id, meeting_type_id, title, created_by)
           values ($1, $2, $3, 'Cross-tenant reference', $4)`,
          [workspaceA, companyB, ownType.rows[0].id, userA],
        ),
      ).rejects.toThrow(/foreign key|violates row-level security/i);

      await expect(
        db.query(
          `insert into public.projects (workspace_id, company_id, name, created_by)
           values ($1, $2, 'Cross-tenant project', $3)`,
          [workspaceA, companyB, userA],
        ),
      ).rejects.toThrow(/violates foreign key constraint|row-level security/i);

      await expect(
        db.query(
          `insert into public.projects (workspace_id, name, created_by)
           values ($1, 'Forged workspace project', $2)`,
          [workspaceB, userA],
        ),
      ).rejects.toThrow(/row-level security|permission denied/i);

      await expect(
        db.query(
          `insert into public.meetings
            (workspace_id, project_id, meeting_type_id, title, created_by)
           values ($1, $2, $3, 'Cross-tenant project reference', $4)`,
          [workspaceA, projectB, ownType.rows[0].id, userA],
        ),
      ).rejects.toThrow(/violates foreign key constraint|row-level security/i);

      await expect(
        db.query(
          `insert into public.workspace_members (workspace_id, user_id, role)
           values ($1, $2, 'owner')`,
          [workspaceB, userA],
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('rejects a meeting that combines a project and a different company in the same workspace', async () => {
    const workspaceId = await createWorkspace(userA, 'Context check', 'context-check');

    await asUser(userA, async () => {
      const companies = await db.query<IdRow>(
        `insert into public.companies (workspace_id, name, created_by)
         values ($1, 'Company One', $2), ($1, 'Company Two', $2)
         returning id`,
        [workspaceId, userA],
      );
      expect(companies.rows).toHaveLength(2);

      const project = await db.query<IdRow>(
        `insert into public.projects (workspace_id, company_id, name, created_by)
         values ($1, $2, 'Company One project', $3) returning id`,
        [workspaceId, companies.rows[0].id, userA],
      );
      const meetingType = await db.query<IdRow>(
        `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
        [workspaceId],
      );

      await expect(
        db.query(
          `insert into public.meetings
            (workspace_id, company_id, project_id, meeting_type_id, title, created_by)
           values ($1, $2, $3, $4, 'Mismatched context', $5)`,
          [workspaceId, companies.rows[1].id, project.rows[0].id, meetingType.rows[0].id, userA],
        ),
      ).rejects.toThrow(/must match the selected project company/i);
    });
  });

  it('allows an active member to create drafts but rejects future lifecycle states', async () => {
    const workspaceId = await createWorkspace(userA, 'Drafts', 'drafts');
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role, membership_status)
       values ($1, $2, 'member', 'active')`,
      [workspaceId, userMember],
    );

    await asUser(userMember, async () => {
      const meetingType = await db.query<IdRow>(
        `select id from public.meeting_types where workspace_id = $1 and key = 'general'`,
        [workspaceId],
      );
      const draft = await db.query<{ status: string }>(
        `insert into public.meetings (workspace_id, meeting_type_id, title, created_by)
         values ($1, $2, 'New meeting', $3)
         returning status::text`,
        [workspaceId, meetingType.rows[0].id, userMember],
      );
      expect(draft.rows[0]).toEqual({ status: 'draft' });

      await expect(
        db.query(
          `insert into public.meetings
            (workspace_id, meeting_type_id, title, status, created_by)
           values ($1, $2, 'Forged ready state', 'ready', $3)`,
          [workspaceId, meetingType.rows[0].id, userMember],
        ),
      ).rejects.toThrow(/invalid input value for enum|row-level security|permission denied/i);
    });
  });
});
