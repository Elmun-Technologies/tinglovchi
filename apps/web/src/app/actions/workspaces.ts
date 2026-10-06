'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createCompanyInputSchema,
  createMeetingInputSchema,
  createProjectInputSchema,
  createWorkspaceInputSchema,
} from '@suhbat/contracts';
import { createSupabaseServerClient } from '@suhbat/database/server';
import type { Database } from '@suhbat/database/types';
import { toWorkspaceSlug } from '@suhbat/shared';

type WorkspaceRole = Database['public']['Enums']['membership_role'];
type ServerSupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

function formObject(formData: FormData) {
  return Object.fromEntries(formData.entries());
}

function workspaceErrorPath(workspaceId: unknown, error: string): string {
  if (typeof workspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(workspaceId)) {
    return `/w/${workspaceId}?error=${error}`;
  }
  return `/?error=${error}`;
}

async function getActiveWorkspaceRole(
  supabase: ServerSupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role, membership_status')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || data?.membership_status !== 'active') return null;
  return data.role;
}

function canManageCompanyProject(role: WorkspaceRole | null): boolean {
  return role === 'owner' || role === 'admin';
}

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const parsed = createWorkspaceInputSchema.safeParse(formObject(formData));
  if (!parsed.success) redirect('/?error=invalid-workspace');

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect('/login');

  const { data: workspaceId, error } = await supabase.rpc('create_workspace', {
    p_name: parsed.data.name,
    p_slug: toWorkspaceSlug(parsed.data.name),
  });
  if (error || !workspaceId) redirect('/?error=workspace-create');

  revalidatePath('/');
  redirect(`/w/${workspaceId}`);
}

export async function createCompanyAction(formData: FormData): Promise<void> {
  const parsed = createCompanyInputSchema.safeParse(formObject(formData));
  if (!parsed.success) redirect(workspaceErrorPath(formData.get('workspaceId'), 'invalid-company'));

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect('/login');
  const role = await getActiveWorkspaceRole(supabase, parsed.data.workspaceId, authData.user.id);
  if (!canManageCompanyProject(role)) {
    redirect(workspaceErrorPath(parsed.data.workspaceId, 'forbidden-role'));
  }

  const { error } = await supabase.from('companies').insert({
    workspace_id: parsed.data.workspaceId,
    name: parsed.data.name,
    description: parsed.data.description,
    created_by: authData.user.id,
  });
  if (error) redirect(workspaceErrorPath(parsed.data.workspaceId, 'company-create'));

  revalidatePath(`/w/${parsed.data.workspaceId}`);
  redirect(`/w/${parsed.data.workspaceId}#companies`);
}

export async function createProjectAction(formData: FormData): Promise<void> {
  const parsed = createProjectInputSchema.safeParse(formObject(formData));
  if (!parsed.success) redirect(workspaceErrorPath(formData.get('workspaceId'), 'invalid-project'));

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect('/login');
  const role = await getActiveWorkspaceRole(supabase, parsed.data.workspaceId, authData.user.id);
  if (!canManageCompanyProject(role)) {
    redirect(workspaceErrorPath(parsed.data.workspaceId, 'forbidden-role'));
  }

  const { error } = await supabase.from('projects').insert({
    workspace_id: parsed.data.workspaceId,
    company_id: parsed.data.companyId,
    name: parsed.data.name,
    description: parsed.data.description,
    created_by: authData.user.id,
  });
  if (error) redirect(workspaceErrorPath(parsed.data.workspaceId, 'project-create'));

  revalidatePath(`/w/${parsed.data.workspaceId}`);
  redirect(`/w/${parsed.data.workspaceId}#projects`);
}

export async function createMeetingAction(formData: FormData): Promise<void> {
  const parsed = createMeetingInputSchema.safeParse(formObject(formData));
  if (!parsed.success) redirect(workspaceErrorPath(formData.get('workspaceId'), 'invalid-meeting'));

  const supabase = await createSupabaseServerClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect('/login');
  const role = await getActiveWorkspaceRole(supabase, parsed.data.workspaceId, authData.user.id);
  if (!role) redirect(workspaceErrorPath(parsed.data.workspaceId, 'workspace-access'));

  const { error } = await supabase.from('meetings').insert({
    workspace_id: parsed.data.workspaceId,
    company_id: parsed.data.companyId,
    project_id: parsed.data.projectId,
    meeting_type_id: parsed.data.meetingTypeId,
    title: parsed.data.title,
    status: 'draft',
    created_by: authData.user.id,
  });
  if (error) redirect(workspaceErrorPath(parsed.data.workspaceId, 'meeting-create'));

  revalidatePath(`/w/${parsed.data.workspaceId}`);
  redirect(`/w/${parsed.data.workspaceId}#meetings`);
}
