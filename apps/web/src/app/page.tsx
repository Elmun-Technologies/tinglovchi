import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Building2, Plus, ShieldCheck, Users } from 'lucide-react';
import { createWorkspaceAction } from './actions/workspaces';
import { createSupabaseServerClient } from '@suhbat/database/server';
import { isSupabaseConfigured } from '@suhbat/database/config';
import { Button, Card, FieldLabel, Input } from '@suhbat/ui';
import { WorkspaceShell } from './components/workspace-shell';
import { routes } from '@suhbat/product';
import { demoDataset } from '@suhbat/product/demo';

export const dynamic = 'force-dynamic';

const errorMessages: Record<string, string> = {
  'invalid-workspace': 'Workspace name must be 2–80 characters.',
  'workspace-create':
    'Workspace could not be created. Check that the database migration is applied, then retry.',
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  if (!isSupabaseConfigured()) {
    return <SetupPage />;
  }

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect('/login');

  const { data: memberships, error: membershipError } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, membership_status')
    .eq('user_id', authData.user.id)
    .eq('membership_status', 'active');

  const workspaceIds = memberships?.map((membership) => membership.workspace_id) ?? [];
  const { data: workspaces, error: workspaceError } = workspaceIds.length
    ? await supabase
        .from('workspaces')
        .select('id, name, slug, created_at')
        .in('id', workspaceIds)
        .order('name')
    : { data: [], error: null };

  const loadError = membershipError || workspaceError;

  return (
    <WorkspaceShell userEmail={authData.user.email || 'Signed-in user'}>
      <div className="mx-auto max-w-5xl">
        <header className="mb-9 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-800">Home</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Your workspaces
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Keep company and project conversations in the right workspace. Each workspace is
              isolated by database policy.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600">
            <ShieldCheck size={15} className="text-teal-800" /> Private by workspace
          </div>
        </header>

        {params.error && errorMessages[params.error] ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            {errorMessages[params.error]}
          </div>
        ) : null}
        {loadError ? (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            Workspace list could not be loaded. Confirm the Phase 1 migration is applied and review
            Supabase logs.
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">Available workspaces</h2>
              <span className="text-xs text-slate-500">{workspaces?.length ?? 0} total</span>
            </div>
            {workspaces?.length ? (
              <div className="grid gap-3">
                {workspaces.map((workspace) => {
                  const membership = memberships?.find(
                    (item) => item.workspace_id === workspace.id,
                  );
                  return (
                    <Link key={workspace.id} href={`/w/${workspace.id}`} className="group block">
                      <Card className="flex items-center justify-between gap-4 p-5 transition-shadow group-hover:shadow-md">
                        <div className="flex min-w-0 items-center gap-4">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-900">
                            <Building2 size={19} />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-950">
                              {workspace.name}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {membership?.role || 'member'} · Created{' '}
                              {new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(
                                new Date(workspace.created_at),
                              )}
                            </p>
                          </div>
                        </div>
                        <ArrowRight
                          size={18}
                          className="shrink-0 text-slate-400 transition-transform group-hover:translate-x-1 group-hover:text-slate-800"
                        />
                      </Card>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <Card className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  <Users size={19} />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-slate-900">No workspace yet</h3>
                <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">
                  Create a workspace to organize your companies, projects, and meeting drafts.
                </p>
              </Card>
            )}
          </section>

          <section>
            <Card className="p-5 sm:p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-700">
                <Plus size={18} />
              </div>
              <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-950">
                Create workspace
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                You’ll become its first owner. Default meeting types are provisioned automatically.
              </p>
              <form action={createWorkspaceAction} className="mt-5 space-y-4">
                <div>
                  <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
                  <Input
                    id="workspace-name"
                    name="name"
                    placeholder="e.g. Acme team"
                    required
                    minLength={2}
                    maxLength={80}
                  />
                </div>
                <Button type="submit" className="w-full">
                  Create workspace <ArrowRight size={16} />
                </Button>
              </form>
            </Card>
          </section>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function SetupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f8fa] px-5 py-12">
      <Card className="w-full max-w-2xl p-7 sm:p-10">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-800 text-white">
          <Building2 size={21} />
        </div>
        <p className="mt-7 text-xs font-bold uppercase tracking-[0.18em] text-teal-800">
          Phase 1 foundation
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Connect a Supabase project
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
          The application is running, but authentication and workspace data are intentionally
          unavailable until a Supabase project is configured.
        </p>
        <ol className="mt-7 space-y-3 text-sm text-slate-700">
          <li className="flex gap-3">
            <span className="font-semibold text-teal-800">01</span>
            <span>
              Copy <code className="rounded bg-slate-100 px-1.5 py-0.5">.env.example</code> to{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5">apps/web/.env.local</code>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-semibold text-teal-800">02</span>
            <span>
              Set{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5">NEXT_PUBLIC_SUPABASE_URL</code>{' '}
              and{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5">
                NEXT_PUBLIC_SUPABASE_ANON_KEY
              </code>
              .
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-semibold text-teal-800">03</span>
            <span>Apply the migrations, then restart the web app and sign in.</span>
          </li>
        </ol>
        <p className="mt-7 border-t border-slate-100 pt-5 text-xs leading-5 text-slate-500">
          No demo account or customer data is included. A Supabase service-role key is not required
          by this web app.
        </p>
      </Card>
      <DemoWorkspaceCard />
    </main>
  );
}

/**
 * The product routes in this build read typed demo fixtures, so they are walkable before a database exists.
 * This entry point is deliberately separate from the Supabase setup steps above: it opens the demo workspace
 * and says plainly that nothing behind it is connected.
 */
function DemoWorkspaceCard() {
  const workspace = demoDataset.workspaces[0];
  if (!workspace) return null;
  const meetings = demoDataset.meetings.length;
  return (
    <Card className="mt-6 w-full max-w-2xl p-7 sm:p-10">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-800">
        Product experience · demo data
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
        Walk the workspace without a backend
      </h2>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Dashboard, meetings, transcript, topics, decisions, tasks, companies, projects, knowledge,
        Ask AI and settings run on{' '}
        <code className="rounded bg-slate-100 px-1.5 py-0.5">{meetings}</code> versioned demo
        meetings with their transcripts, citations and deadlines. No transcription, AI or storage is
        connected, and the screens say so where it matters.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link
          href={routes.home({ workspaceId: workspace.id })}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-teal-800 px-4 text-sm font-semibold text-white transition-colors hover:bg-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-800"
        >
          Open {workspace.name} <ArrowRight size={16} />
        </Link>
        <span className="text-xs text-slate-500">
          Selected by <code className="rounded bg-slate-100 px-1.5 py-0.5">SUHBAT_DATA_MODE</code>.
          Live mode reads this workspace through the signed-in Supabase session, under PostgreSQL RLS.
        </span>
      </div>
    </Card>
  );
}
