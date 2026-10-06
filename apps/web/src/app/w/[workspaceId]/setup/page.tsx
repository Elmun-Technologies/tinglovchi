import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Building2, CalendarDays, FolderKanban, Plus, Users } from 'lucide-react';
import {
  createCompanyAction,
  createMeetingAction,
  createProjectAction,
} from '../../../actions/workspaces';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { workspaceIdSchema } from '@suhbat/contracts';
import { isSupabaseConfigured } from '@suhbat/database/config';
import { createSupabaseServerClient } from '@suhbat/database/server';
import { Button, Card, FieldLabel, Input, Select, StatusBadge } from '@suhbat/ui';

export const dynamic = 'force-dynamic';

const errorMessages: Record<string, string> = {
  'invalid-company': 'Company name or description is invalid.',
  'forbidden-role': 'Only workspace owners and admins can manage companies or projects.',
  'workspace-access': 'You must be an active workspace member to create a meeting draft.',
  'company-create': 'Company could not be created. Verify membership and migration status.',
  'invalid-project': 'Project name or description is invalid.',
  'project-create':
    'Project could not be created. Check that the selected company belongs to this workspace.',
  'invalid-meeting': 'Meeting title or selected context is invalid.',
  'meeting-create':
    'Meeting draft could not be created. Confirm the selections belong to this workspace.',
};

type WorkspacePageProps = {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ error?: string }>;
};

export default async function WorkspacePage({ params, searchParams }: WorkspacePageProps) {
  const [{ workspaceId: rawWorkspaceId }, query] = await Promise.all([params, searchParams]);
  const parsedId = workspaceIdSchema.safeParse(rawWorkspaceId);
  if (!parsedId.success) notFound();
  const workspaceId = parsedId.data;
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect('/login');

  const [
    workspaceResult,
    membershipResult,
    companiesResult,
    projectsResult,
    typesResult,
    meetingsResult,
  ] = await Promise.all([
    supabase.from('workspaces').select('id, name, slug').eq('id', workspaceId).maybeSingle(),
    supabase
      .from('workspace_members')
      .select('role, membership_status')
      .eq('workspace_id', workspaceId)
      .eq('user_id', authData.user.id)
      .maybeSingle(),
    supabase
      .from('companies')
      .select('id, name, description, created_at')
      .eq('workspace_id', workspaceId)
      .is('archived_at', null)
      .order('name'),
    supabase
      .from('projects')
      .select('id, company_id, name, description, created_at')
      .eq('workspace_id', workspaceId)
      .is('archived_at', null)
      .order('name'),
    supabase
      .from('meeting_types')
      .select('id, key, display_name, sort_order')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .order('sort_order'),
    supabase
      .from('meetings')
      .select('id, title, status, created_at, company_id, project_id, meeting_type_id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false }),
  ]);

  if (
    !workspaceResult.data ||
    !membershipResult.data ||
    membershipResult.data.membership_status !== 'active'
  ) {
    notFound();
  }

  const canManageCompanyProject =
    membershipResult.data.role === 'owner' || membershipResult.data.role === 'admin';
  const companies = companiesResult.data ?? [];
  const projects = projectsResult.data ?? [];
  const meetingTypes = typesResult.data ?? [];
  const meetings = meetingsResult.data ?? [];
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const meetingTypeNames = new Map(meetingTypes.map((type) => [type.id, type.display_name]));
  const loadError = [
    companiesResult.error,
    projectsResult.error,
    typesResult.error,
    meetingsResult.error,
  ].some(Boolean);

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      workspaceName={workspaceResult.data.name}
      userEmail={authData.user.email || 'Signed-in user'}
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              <ArrowLeft size={14} /> All workspaces
            </Link>
            <p className="mt-4 text-xs font-bold uppercase tracking-[0.18em] text-teal-800">
              Workspace
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
              {workspaceResult.data.name}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              Owners and admins manage company/project context; all active members can create
              meeting drafts. Recording and analysis are not enabled in this phase.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium capitalize text-slate-600">
            <Users size={15} className="text-teal-800" /> Workspace role:{' '}
            {membershipResult.data.role}
          </div>
        </div>

        {query.error && errorMessages[query.error] ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            {errorMessages[query.error]}
          </div>
        ) : null}
        {loadError ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          >
            Some workspace data could not be loaded. Check the applied migration and Supabase logs;
            hidden rows remain protected by RLS.
          </div>
        ) : null}

        <section className="mb-8 grid gap-4 sm:grid-cols-3" aria-label="Workspace overview">
          <Metric icon={<Building2 size={17} />} label="Companies" value={companies.length} />
          <Metric icon={<FolderKanban size={17} />} label="Projects" value={projects.length} />
          <Metric
            icon={<CalendarDays size={17} />}
            label="Meeting drafts"
            value={meetings.length}
          />
        </section>

        <div className="grid items-start gap-6 xl:grid-cols-2">
          <Card className="p-5 sm:p-6" id="companies">
            <SectionHeading
              icon={<Building2 size={17} />}
              title="Companies"
              detail={
                canManageCompanyProject
                  ? 'Client and organization context'
                  : 'Read-only context managed by workspace owners/admins'
              }
            />
            {canManageCompanyProject ? (
              <form
                action={createCompanyAction}
                className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
              >
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <div>
                  <FieldLabel htmlFor="company-name">Company name</FieldLabel>
                  <Input
                    id="company-name"
                    name="name"
                    placeholder="Company or client"
                    required
                    minLength={2}
                    maxLength={120}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="company-description">
                    Description <span className="font-normal text-slate-400">(optional)</span>
                  </FieldLabel>
                  <Input
                    id="company-description"
                    name="description"
                    placeholder="Short context"
                    maxLength={1000}
                  />
                </div>
                <Button type="submit">
                  <Plus size={16} /> Add
                </Button>
              </form>
            ) : (
              <p className="mt-5 text-xs text-slate-500">
                Company management is limited to workspace owners and admins.
              </p>
            )}
            <div className="mt-5 border-t border-slate-100 pt-2">
              {companies.length ? (
                companies.map((company) => (
                  <div
                    key={company.id}
                    className="flex items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800">
                        {company.name}
                      </p>
                      {company.description ? (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {company.description}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatDate(company.created_at)}
                    </span>
                  </div>
                ))
              ) : (
                <EmptyInline
                  text={
                    canManageCompanyProject
                      ? 'No companies yet. Add one above when you’re ready.'
                      : 'No companies yet. Ask a workspace owner or admin to add one.'
                  }
                />
              )}
            </div>
          </Card>

          <Card className="p-5 sm:p-6" id="projects">
            <SectionHeading
              icon={<FolderKanban size={17} />}
              title="Projects"
              detail={
                canManageCompanyProject
                  ? 'Optional grouping within a workspace'
                  : 'Read-only context managed by workspace owners/admins'
              }
            />
            {canManageCompanyProject ? (
              <form action={createProjectAction} className="mt-5 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <div>
                  <FieldLabel htmlFor="project-name">Project name</FieldLabel>
                  <Input
                    id="project-name"
                    name="name"
                    placeholder="Project name"
                    required
                    minLength={2}
                    maxLength={120}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="project-company">
                    Company <span className="font-normal text-slate-400">(optional)</span>
                  </FieldLabel>
                  <Select id="project-company" name="companyId" defaultValue="">
                    <option value="">No company</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <FieldLabel htmlFor="project-description">
                    Description <span className="font-normal text-slate-400">(optional)</span>
                  </FieldLabel>
                  <Input
                    id="project-description"
                    name="description"
                    placeholder="Short context"
                    maxLength={1000}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit">
                    <Plus size={16} /> Add project
                  </Button>
                </div>
              </form>
            ) : (
              <p className="mt-5 text-xs text-slate-500">
                Project management is limited to workspace owners and admins.
              </p>
            )}
            <div className="mt-5 border-t border-slate-100 pt-2">
              {projects.length ? (
                projects.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800">
                        {project.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {project.company_id
                          ? companyNames.get(project.company_id)
                          : 'Workspace project'}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatDate(project.created_at)}
                    </span>
                  </div>
                ))
              ) : (
                <EmptyInline
                  text={
                    canManageCompanyProject
                      ? 'No projects yet. Add one above when useful.'
                      : 'No projects yet. Ask a workspace owner or admin to add one.'
                  }
                />
              )}
            </div>
          </Card>
        </div>

        <Card className="mt-6 p-5 sm:p-6" id="meetings">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <SectionHeading
              icon={<CalendarDays size={17} />}
              title="Meeting drafts"
              detail="Create a workspace-scoped meeting record"
            />
            <StatusBadge>Recording not enabled</StatusBadge>
          </div>
          <form
            action={createMeetingAction}
            className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5 xl:items-end"
          >
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="md:col-span-2 xl:col-span-1">
              <FieldLabel htmlFor="meeting-title">Meeting title</FieldLabel>
              <Input
                id="meeting-title"
                name="title"
                placeholder="Meeting title"
                required
                minLength={2}
                maxLength={180}
              />
            </div>
            <div>
              <FieldLabel htmlFor="meeting-type">Meeting type</FieldLabel>
              <Select id="meeting-type" name="meetingTypeId" required defaultValue="">
                <option value="" disabled>
                  Select type
                </option>
                {meetingTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.display_name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="meeting-company">Company</FieldLabel>
              <Select id="meeting-company" name="companyId" defaultValue="">
                <option value="">No company</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="meeting-project">Project</FieldLabel>
              <Select id="meeting-project" name="projectId" defaultValue="">
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="md:col-span-2 xl:col-span-1">
              <Button type="submit" className="w-full">
                <Plus size={16} /> Create draft
              </Button>
            </div>
          </form>

          <div className="mt-6 overflow-x-auto border-t border-slate-100 pt-2">
            {meetings.length ? (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-3">Meeting</th>
                    <th className="px-3 py-3">Company / project</th>
                    <th className="px-3 py-3">Type</th>
                    <th className="px-3 py-3">Created</th>
                    <th className="px-3 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((meeting) => (
                    <tr key={meeting.id} className="border-t border-slate-100">
                      <td className="px-3 py-3 font-medium text-slate-800">{meeting.title}</td>
                      <td className="px-3 py-3 text-slate-600">
                        {meeting.company_id ? companyNames.get(meeting.company_id) : '—'}
                        {meeting.project_id
                          ? ` · ${projectNames.get(meeting.project_id) || 'Project'}`
                          : ''}
                      </td>
                      <td className="px-3 py-3 text-slate-600">
                        {meetingTypeNames.get(meeting.meeting_type_id) || '—'}
                      </td>
                      <td className="px-3 py-3 text-slate-500">{formatDate(meeting.created_at)}</td>
                      <td className="px-3 py-3">
                        <StatusBadge>{meeting.status}</StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyInline text="No meetings yet. Create a draft above; recording and processing arrive in later phases." />
            )}
          </div>
        </Card>

        <section id="settings" className="mt-6">
          <Card className="p-5 sm:p-6">
            <SectionHeading
              icon={<Users size={17} />}
              title="Workspace settings"
              detail="Read-only foundation in Phase 1"
            />
            <dl className="mt-5 grid gap-4 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-slate-500">Workspace slug</dt>
                <dd className="mt-1 font-mono text-slate-800">{workspaceResult.data.slug}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-slate-500">Your role</dt>
                <dd className="mt-1 capitalize text-slate-800">{membershipResult.data.role}</dd>
              </div>
            </dl>
          </Card>
        </section>
      </div>
    </WorkspaceShell>
  );
}

function SectionHeading({
  icon,
  title,
  detail,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
        {icon}
      </div>
      <div>
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
        {icon}
      </div>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-0.5 text-lg font-semibold text-slate-950">{value}</p>
      </div>
    </Card>
  );
}

function EmptyInline({ text }: { text: string }) {
  return <p className="py-5 text-sm text-slate-500">{text}</p>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
}

function SetupRequired() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fa] px-5 py-12">
      <Card className="w-full max-w-xl p-8">
        <h1 className="text-xl font-semibold text-slate-950">Supabase is not configured</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Add the public Supabase URL and anon key to <code>apps/web/.env.local</code>, then reload
          this workspace.
        </p>
        <Link href="/" className="mt-5 inline-flex text-sm font-semibold text-teal-800">
          Back to workspaces
        </Link>
      </Card>
    </main>
  );
}
