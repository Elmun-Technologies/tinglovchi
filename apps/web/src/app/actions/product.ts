'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  RepositoryError,
  can,
  routes,
  type WriteActionKey,
  type ProductRepositories,
} from '@suhbat/product';
import {
  companyCreateInputSchema,
  companyUpdateInputSchema,
  meetingDraftCreateInputSchema,
  meetingDraftUpdateInputSchema,
  meetingTypeCreateInputSchema,
  meetingTypeUpdateInputSchema,
  memberInviteInputSchema,
  memberRemoveInputSchema,
  memberRoleUpdateInputSchema,
  parseWriteInput,
  projectCreateInputSchema,
  projectUpdateInputSchema,
  speakerMappingCommitSchema,
  toBoolean,
  vocabularyCreateInputSchema,
  vocabularyUpdateInputSchema,
  workspaceRenameInputSchema,
} from '@suhbat/product';
import { dataMode, getRepositories } from '../../lib/repositories';
import { isSidebarCollapsed, SIDEBAR_COOKIE, SIDEBAR_COLLAPSED } from '../../lib/sidebar';

/**
 * Server actions for the product surface.
 *
 * Three rules hold here, and they are the reason this file is written the way it is:
 *
 * 1. A mutation is attempted only when the active adapter declares that action enabled (`can(capabilities, …)`),
 *    never because a method happened to exist — the live placeholder answers every method name with a rejection.
 * 2. Validation and business rules run in the repository layer (`@suhbat/product/writes` + the adapter), so the
 *    same input is rejected whether it arrived from this form, a future API client, or a test.
 * 3. The outcome is a code in the address bar, not a toast: a success message can only be shown after the write
 *    actually happened, and it survives a reload. A refusal carries the adapter's own explanation as `reason`,
 *    because "not allowed" without a why is not information.
 */

const FEEDBACK_PARAM = 'notice';

function text(formData: FormData, key: string): string {
  const raw = formData.get(key);
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : '';
  return typeof raw === 'string' ? raw : '';
}

function list(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function nextPath(formData: FormData, fallback: string): string {
  const raw = text(formData, 'next');
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : fallback;
}

function withNotice(path: string, notice: string, reason?: string): string {
  const url = new URL(`https://app.invalid${path}`);
  url.searchParams.set(FEEDBACK_PARAM, notice);
  const detail = reason?.trim();
  // A refusal the adapter explained is worth showing; an unexplained one keeps the generic sentence.
  if (detail && notice.startsWith('error:') && detail.length <= 300)
    url.searchParams.set('reason', detail.slice(0, 300));
  else url.searchParams.delete('reason');
  return `${url.pathname}${url.search}`;
}

function workspaceOf(formData: FormData): string {
  const workspaceId = text(formData, 'workspaceId');
  if (!workspaceId)
    throw new RepositoryError(
      'validation_failed',
      'The form did not say which workspace to write to.',
    );
  return workspaceId;
}

/**
 * The single gate in front of every mutation. It reads the capability record rather than the shape of the
 * adapter, so a partially wired live adapter cannot be talked into a write by a form that rendered anyway.
 */
function require(repositories: ProductRepositories, action: WriteActionKey): void {
  if (!can(repositories.capabilities, action))
    throw new RepositoryError(
      'unsupported_in_demo',
      `This data source cannot perform that action (${action}).`,
      {
        hint: repositories.capabilities.persistenceLabel,
      },
    );
}

async function run(
  formData: FormData,
  notice: string,
  action: WriteActionKey,
  work: (repositories: ProductRepositories) => Promise<unknown>,
  fallback: string,
): Promise<void> {
  const path = nextPath(formData, fallback);
  const repositories = getRepositories();
  try {
    require(repositories, action);
    // A create returns the address of the record it made, so the reader lands on it; an update lands wherever
    // the form asked, which is normally the page the form was opened from.
    const result = await work(repositories);
    const target = typeof result === 'string' ? result : path;
    revalidatePath('/', 'layout');
    redirect(withNotice(target, notice));
    return;
  } catch (cause) {
    const error = cause instanceof RepositoryError ? cause : null;
    redirect(
      withNotice(
        path,
        error ? `error:${error.code}` : 'error:provider_unavailable',
        error?.message,
      ),
    );
  }
}

/**
 * Collapse/expand is a cookie and a redirect instead of client state: the preference survives navigation and a
 * reload, and the sidebar renders correctly on first paint with no hydration work. The layout reads the same
 * cookie, which is why no client state is involved.
 */
export async function toggleSidebarAction(formData: FormData): Promise<void> {
  const store = await cookies();
  const current = isSidebarCollapsed(store.get(SIDEBAR_COOKIE)?.value)
    ? 'expanded'
    : SIDEBAR_COLLAPSED;
  store.set(SIDEBAR_COOKIE, current, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  redirect(nextPath(formData, '/'));
}

/**
 * Demo-only pipeline step. The button that calls this is labelled as a development affordance, and the
 * adapter refuses when the meeting is not mid-pipeline, so no screen can imply a transcription ran.
 */
export async function advanceMeetingStateAction(formData: FormData): Promise<void> {
  const meetingId = text(formData, 'meetingId');
  await run(
    formData,
    'state-advanced',
    'demo.pipeline',
    async (repositories) => {
      if (dataMode() !== 'demo')
        throw new RepositoryError(
          'unsupported_in_demo',
          'Only the demo adapter can move a meeting through the fixture pipeline.',
        );
      if (!repositories.meetings.advanceDemoState)
        throw new RepositoryError(
          'unsupported_in_demo',
          'This adapter has no pipeline to advance.',
        );
      return repositories.meetings.advanceDemoState(meetingId);
    },
    '/',
  );
}

export async function setTaskStatusAction(formData: FormData): Promise<void> {
  const taskId = text(formData, 'taskId');
  const rawStatus = text(formData, 'status') || 'open';
  const allowed = ['open', 'in_progress', 'blocked', 'completed', 'cancelled'] as const;
  const status = (allowed as readonly string[]).includes(rawStatus) ? rawStatus : 'open';
  await run(
    formData,
    'task-updated',
    'task.status',
    async (repositories) => {
      if (!repositories.tasks.updateStatus)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot write task status.');
      return repositories.tasks.updateStatus(taskId, status as (typeof allowed)[number]);
    },
    '/',
  );
}

export async function confirmSpeakerMappingAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const meetingId = text(formData, 'meetingId');
  const values = {
    meetingId,
    label: text(formData, 'label'),
    personId: text(formData, 'personId'),
  };
  await run(
    formData,
    'mapping-confirmed',
    'transcript.speakerMapping',
    async (repositories) => {
      if (!repositories.transcripts.confirmSpeakerMapping)
        throw new RepositoryError(
          'unsupported_in_demo',
          'This adapter cannot persist a speaker mapping.',
        );
      const input = parseWriteInput(speakerMappingCommitSchema, values);
      return repositories.transcripts.confirmSpeakerMapping(input);
    },
    routes.transcript({ workspaceId, meetingId }),
  );
}

/* ------------------------------------------------------------------ companies */

function companyValues(formData: FormData) {
  return {
    workspaceId: workspaceOf(formData),
    name: text(formData, 'name'),
    description: text(formData, 'description'),
  };
}

/** One action for create and edit, because the form and the rules are the same; `companyId` decides which. */
export async function saveCompanyAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const companyId = text(formData, 'companyId');
  const values = companyValues(formData);
  const created = companyId === '';
  await run(
    formData,
    created ? 'record-created' : 'record-updated',
    created ? 'company.create' : 'company.update',
    async (repositories) => {
      if (!repositories.companies.create || !repositories.companies.update)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot save companies.');
      if (created) {
        const input = parseWriteInput(companyCreateInputSchema, values);
        const company = await repositories.companies.create(input);
        return routes.company({ workspaceId, companyId: company.id });
      }
      const input = parseWriteInput(companyUpdateInputSchema, values);
      await repositories.companies.update(companyId, input);
      return nextPath(formData, routes.company({ workspaceId, companyId }));
    },
    routes.companies({ workspaceId }),
  );
}

/** Archive is the product's delete: the record stays, the list defaults exclude it. */
export async function setCompanyArchivedAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const companyId = text(formData, 'companyId');
  const archived = toBoolean(text(formData, 'archived'), true);
  await run(
    formData,
    archived ? 'record-archived' : 'record-restored',
    'company.archive',
    async (repositories) => {
      if (!repositories.companies.setArchived)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot archive a company.');
      return repositories.companies.setArchived(companyId, archived);
    },
    routes.companies({ workspaceId }),
  );
}

/* ------------------------------------------------------------------ projects */

export async function saveProjectAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const projectId = text(formData, 'projectId');
  const values = {
    workspaceId,
    name: text(formData, 'name'),
    companyId: text(formData, 'companyId'),
    description: text(formData, 'description'),
    status: text(formData, 'status') || undefined,
  };
  const created = projectId === '';
  await run(
    formData,
    created ? 'record-created' : 'record-updated',
    created ? 'project.create' : 'project.update',
    async (repositories) => {
      if (!repositories.projects.create || !repositories.projects.update)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot save projects.');
      if (created) {
        const input = parseWriteInput(projectCreateInputSchema, values);
        const project = await repositories.projects.create(input);
        return routes.project({ workspaceId, projectId: project.id });
      }
      const input = parseWriteInput(projectUpdateInputSchema, values);
      await repositories.projects.update(projectId, input);
      return nextPath(formData, routes.project({ workspaceId, projectId }));
    },
    routes.projects({ workspaceId }),
  );
}

export async function setProjectArchivedAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const projectId = text(formData, 'projectId');
  const archived = toBoolean(text(formData, 'archived'), true);
  await run(
    formData,
    archived ? 'record-archived' : 'record-restored',
    'project.archive',
    async (repositories) => {
      if (!repositories.projects.setArchived)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot close a project.');
      return repositories.projects.setArchived(projectId, archived);
    },
    routes.projects({ workspaceId }),
  );
}

/* ------------------------------------------------------------------ meeting drafts */

function draftValues(formData: FormData) {
  return {
    workspaceId: workspaceOf(formData),
    title: text(formData, 'title'),
    meetingTypeId: text(formData, 'meetingTypeId'),
    companyId: text(formData, 'companyId'),
    projectId: text(formData, 'projectId'),
    participantIds: list(formData, 'participantIds'),
    occurredAt: text(formData, 'occurredAt') || undefined,
    durationMinutes: text(formData, 'durationMinutes') || undefined,
    notes: text(formData, 'notes'),
  };
}

/**
 * The New Meeting flow ends here, and it ends at a draft. Nothing in this action starts, schedules or implies a
 * recording; if the adapter has no draft write path, the refusal is reported instead of a green message.
 */
export async function saveMeetingDraftAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const meetingId = text(formData, 'meetingId');
  const values = draftValues(formData);
  const created = meetingId === '';
  await run(
    formData,
    created ? 'draft-created' : 'record-updated',
    created ? 'meeting.draft.create' : 'meeting.draft.update',
    async (repositories) => {
      if (!repositories.meetings.createDraft)
        throw new RepositoryError(
          'unsupported_in_demo',
          'This data source has no draft write path.',
        );
      if (created) {
        const input = parseWriteInput(meetingDraftCreateInputSchema, values);
        const meeting = await repositories.meetings.createDraft(input);
        return routes.meeting({ workspaceId, meetingId: meeting.id });
      }
      if (!repositories.meetings.updateDraft)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot edit a draft.');
      const input = parseWriteInput(meetingDraftUpdateInputSchema, values);
      await repositories.meetings.updateDraft(meetingId, input);
      return nextPath(formData, routes.meeting({ workspaceId, meetingId }));
    },
    routes.meetings({ workspaceId }),
  );
}

export async function deleteMeetingDraftAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const meetingId = text(formData, 'meetingId');
  await run(
    formData,
    'record-deleted',
    'meeting.draft.delete',
    async (repositories) => {
      if (!repositories.meetings.deleteDraft)
        throw new RepositoryError(
          'unsupported_in_demo',
          'This adapter cannot delete a draft. Only an unrecorded draft is deletable anywhere in this product.',
        );
      return repositories.meetings.deleteDraft(meetingId);
    },
    routes.meetings({ workspaceId }),
  );
}

/* ------------------------------------------------------------------ settings */

export async function saveMeetingTypeAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const meetingTypeId = text(formData, 'meetingTypeId');
  const created = meetingTypeId === '';
  const displayName = text(formData, 'displayName');
  const key = text(formData, 'key');
  // A create is always active; an edit sends its lifecycle explicitly so "unchecked" is never a guess.
  const activeState = text(formData, 'activeState');
  await run(
    formData,
    'settings-saved',
    created ? 'meetingType.create' : 'meetingType.update',
    async (repositories) => {
      if (created) {
        if (!repositories.settings.createMeetingType)
          throw new RepositoryError(
            'unsupported_in_demo',
            'This adapter cannot add a meeting type.',
          );
        const input = parseWriteInput(meetingTypeCreateInputSchema, {
          workspaceId,
          key,
          displayName,
        });
        return repositories.settings.createMeetingType(input);
      }
      if (!repositories.settings.updateMeetingType)
        throw new RepositoryError(
          'unsupported_in_demo',
          'This adapter cannot change a meeting type.',
        );
      const input = parseWriteInput(meetingTypeUpdateInputSchema, {
        displayName: displayName || undefined,
        ...(activeState === 'active' || activeState === 'inactive'
          ? { active: activeState === 'active' }
          : {}),
      });
      return repositories.settings.updateMeetingType(meetingTypeId, input);
    },
    routes.settings({ workspaceId }, 'meetingTypes'),
  );
}

export async function saveVocabularyTermAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const termId = text(formData, 'termId');
  const op = text(formData, 'op') || (termId ? 'update' : 'create');
  // `<input type=hidden value=false>` before `<input type=checkbox value=true>`: the pair is unambiguous.
  const enabled = list(formData, 'enabled').includes('true');
  const term = text(formData, 'term');
  const context = text(formData, 'context');
  const scope = text(formData, 'scope') || 'workspace';
  const companyId = text(formData, 'companyId');
  const meetingId = text(formData, 'meetingId');
  await run(
    formData,
    op === 'delete' ? 'settings-saved' : 'settings-saved',
    op === 'delete'
      ? 'vocabulary.delete'
      : op === 'update'
        ? 'vocabulary.update'
        : 'vocabulary.create',
    async (repositories) => {
      if (op === 'delete') {
        if (!repositories.settings.deleteVocabulary)
          throw new RepositoryError('unsupported_in_demo', 'This adapter cannot delete a term.');
        return repositories.settings.deleteVocabulary(termId);
      }
      if (op === 'update') {
        if (!repositories.settings.updateVocabulary)
          throw new RepositoryError('unsupported_in_demo', 'This adapter cannot edit a term.');
        const input = parseWriteInput(vocabularyUpdateInputSchema, {
          term: term || undefined,
          context,
          enabled,
        });
        return repositories.settings.updateVocabulary(termId, input);
      }
      if (!repositories.settings.createVocabulary)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot add a term.');
      const input = parseWriteInput(vocabularyCreateInputSchema, {
        workspaceId,
        term,
        context,
        scope,
        companyId,
        meetingId,
        enabled,
      });
      return repositories.settings.createVocabulary(input);
    },
    routes.settings({ workspaceId }, 'vocabulary'),
  );
}

export async function renameWorkspaceAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const name = text(formData, 'name');
  await run(
    formData,
    'settings-saved',
    'workspace.rename',
    async (repositories) => {
      if (!repositories.workspaces.rename)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot rename a workspace.');
      const input = parseWriteInput(workspaceRenameInputSchema, { workspaceId, name });
      return repositories.workspaces.rename(input);
    },
    routes.settings({ workspaceId }, 'workspace'),
  );
}

/* ------------------------------------------------------------------ members */

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const email = text(formData, 'email');
  const role = text(formData, 'role') || 'member';
  await run(
    formData,
    'member-invited',
    'workspace.members.invite',
    async (repositories) => {
      if (!repositories.workspaces.inviteMember)
        throw new RepositoryError(
          'unsupported_in_demo',
          'This adapter cannot record an invitation.',
        );
      const input = parseWriteInput(memberInviteInputSchema, { workspaceId, email, role });
      return repositories.workspaces.inviteMember(input);
    },
    routes.settings({ workspaceId }, 'members'),
  );
}

export async function setMemberRoleAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const personId = text(formData, 'personId');
  const role = text(formData, 'role') || 'member';
  await run(
    formData,
    'member-updated',
    'workspace.members.role',
    async (repositories) => {
      if (!repositories.workspaces.setMemberRole)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot change a role.');
      const input = parseWriteInput(memberRoleUpdateInputSchema, { workspaceId, personId, role });
      return repositories.workspaces.setMemberRole(input);
    },
    routes.settings({ workspaceId }, 'members'),
  );
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const workspaceId = workspaceOf(formData);
  const personId = text(formData, 'personId');
  await run(
    formData,
    'member-removed',
    'workspace.members.remove',
    async (repositories) => {
      if (!repositories.workspaces.removeMember)
        throw new RepositoryError('unsupported_in_demo', 'This adapter cannot remove a member.');
      const input = parseWriteInput(memberRemoveInputSchema, { workspaceId, personId });
      return repositories.workspaces.removeMember(input);
    },
    routes.settings({ workspaceId }, 'members'),
  );
}
