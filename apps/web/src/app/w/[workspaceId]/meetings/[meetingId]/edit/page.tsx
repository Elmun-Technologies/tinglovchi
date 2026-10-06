import {
  Badge,
  ButtonLink,
  Field,
  Input,
  Notice,
  PageHeader,
  SectionCard,
  Select,
  Textarea,
} from '@suhbat/ui';
import {
  can,
  formatDuration,
  routes,
  toRepositoryError,
  type MeetingSummary,
} from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../../../lib/repositories';
import { FlashNotice } from '../../../../../components/flash-notice';
import { WriteForm } from '../../../../../components/write-form';
import { ConfirmAction } from '../../../../../components/confirm-action';
import { deleteMeetingDraftAction, saveMeetingDraftAction } from '../../../../../actions/product';
import { ui } from '../../../../../../copy/ui-copy';

export const metadata = { title: ui.newMeeting.editTitle };

/**
 * Editing a meeting draft.
 *
 * Only a draft is editable here, and the page says why when it is not: once a meeting has been captured, its
 * transcript and records are the surface for corrections, and letting a form rewrite the title or the type of an
 * analyzed meeting would put the label ahead of the evidence. Deletion is the same rule in the other direction —
 * offered here, behind a confirmation, and only while the draft holds nothing.
 */
export default async function EditMeetingDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; meetingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, meetingId } = await params;
  const query = await searchParams;
  const single = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const repositories = getRepositories();
  const capabilities = getCapabilities();
  const canWrite = can(capabilities, 'meeting.draft.update');
  const canDelete = can(capabilities, 'meeting.draft.delete');
  const loaded = await Promise.all([
    repositories.meetings.detail(meetingId),
    repositories.meetings.meetingTypes(workspaceId),
    repositories.companies.list(workspaceId, { includeArchived: true }),
    repositories.projects.list(workspaceId, { includeArchived: true }),
    repositories.workspaces.members(workspaceId),
  ]).then(
    ([detail, types, companies, projects, members]) => ({
      ok: true as const,
      detail,
      types,
      companies,
      projects,
      members,
    }),
    (cause) => ({ ok: false as const, error: toRepositoryError(cause) }),
  );
  const meetingHref = routes.meeting({ workspaceId, meetingId });

  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader title={ui.newMeeting.editTitle} />
        <Notice tone="danger" title={ui.errors.notFoundTitle}>
          <p>{loaded.error.message}</p>
          {loaded.error.detail ? (
            <p className="font-mono text-[11.5px] text-slate-500">{loaded.error.detail}</p>
          ) : null}
        </Notice>
        <ButtonLink href={routes.meetings({ workspaceId })} variant="secondary" size="sm">
          {ui.writes.back}
        </ButtonLink>
      </div>
    );
  }

  const { detail, types, companies, projects, members } = loaded;
  const isDraft = detail.state === 'draft';
  const selected = new Set(detail.participants.map((participant) => participant.personId));
  const activeTypes = types.filter((type) => type.active || type.id === detail.meetingTypeId);
  const draft = detail as MeetingSummary;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={detail.title}
        description={isDraft ? ui.newMeeting.editIntro : ui.newMeeting.notDraftBody}
        breadcrumbs={[
          { label: ui.nav.meetings, href: routes.meetings({ workspaceId }) },
          { label: detail.title, href: meetingHref },
          { label: ui.writes.edit },
        ]}
        meta={
          <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
            <Badge tone={isDraft ? 'neutral' : 'info'}>{detail.state}</Badge>
            <span>
              {detail.counts.segments} {ui.common.lines} ·{' '}
              {detail.capturedMs === null
                ? ui.newMeeting.notScheduled
                : `${ui.common.captured} ${formatDuration(detail.capturedMs)}`}
            </span>
          </span>
        }
        actions={
          <ButtonLink href={meetingHref} variant="ghost" size="sm">
            {ui.writes.back}
          </ButtonLink>
        }
      />
      <FlashNotice params={query} />

      {isDraft ? (
        <WriteForm
          title={ui.newMeeting.editTitle}
          description={ui.writes.draftIntro}
          action={saveMeetingDraftAction}
          next={meetingHref}
          submitLabel={ui.newMeeting.editSubmit}
          capabilities={capabilities}
          canWrite={canWrite}
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="meetingId" value={meetingId} />
          <Field id="draft-title" label={ui.newMeeting.titleLabel} hint={ui.newMeeting.validation}>
            <Input
              id="draft-title"
              name="title"
              defaultValue={draft.title}
              minLength={2}
              maxLength={180}
              required={canWrite}
              disabled={!canWrite}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="draft-type" label={ui.newMeeting.typeLabel} hint={ui.writes.meetingTypeHint}>
              <Select
                id="draft-type"
                name="meetingTypeId"
                defaultValue={draft.meetingTypeId}
                disabled={!canWrite}
              >
                {activeTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.displayName}
                    {type.active ? '' : ` (${ui.writes.disabledBadge})`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="draft-occurredAt" label={ui.newMeeting.whenLabel} hint={ui.writes.whenHint}>
              <Input
                id="draft-occurredAt"
                name="occurredAt"
                type="datetime-local"
                defaultValue={draft.occurredAt.slice(0, 16)}
                disabled={!canWrite}
              />
            </Field>
            <Field
              id="draft-duration"
              label={ui.newMeeting.durationLabel}
              hint={ui.writes.durationHint}
            >
              <Input
                id="draft-duration"
                name="durationMinutes"
                type="number"
                min={5}
                max={1440}
                step={5}
                defaultValue={
                  draft.durationMs > 0 ? Math.round(draft.durationMs / 60_000) : undefined
                }
                disabled={!canWrite}
              />
            </Field>
            <Field
              id="draft-company"
              label={ui.newMeeting.companyLabel}
              hint={ui.newMeeting.companyHint}
            >
              <Select
                id="draft-company"
                name="companyId"
                defaultValue={draft.companyId ?? ''}
                disabled={!canWrite}
              >
                <option value="">{ui.common.noCompany}</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                    {company.status === 'archived' ? ` (${ui.writes.archivedBadge})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="draft-project"
              label={ui.newMeeting.projectLabel}
              hint={ui.newMeeting.projectHint}
            >
              <Select
                id="draft-project"
                name="projectId"
                defaultValue={draft.projectId ?? ''}
                disabled={!canWrite}
              >
                <option value="">{ui.common.none}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <fieldset disabled={!canWrite}>
            <legend className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {ui.newMeeting.participantsLabel}
            </legend>
            <p className="mb-2 text-[12.5px] text-slate-500">{ui.writes.participantsHint}</p>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {members.map((member) => (
                <li key={member.personId}>
                  <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50 has-checked:border-teal-700/40 has-checked:bg-teal-50/60">
                    <input
                      type="checkbox"
                      name="participantIds"
                      value={member.personId}
                      defaultChecked={selected.has(member.personId)}
                      className="size-4 accent-teal-700"
                    />
                    <span className="min-w-0 flex-1 truncate">{member.name}</span>
                    {member.status === 'invited' ? (
                      <span className="shrink-0 text-[11.5px] text-amber-800">
                        {ui.settingsWrites.invitedBadge}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11.5px] text-slate-400">{member.role}</span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <Field id="draft-notes" label={ui.newMeeting.notesLabel} hint={ui.writes.notesHint}>
            <Textarea
              id="draft-notes"
              name="notes"
              rows={4}
              maxLength={2000}
              defaultValue={detail.executiveSummary[0] ?? ''}
              disabled={!canWrite}
            />
          </Field>
        </WriteForm>
      ) : (
        <Notice tone="info" title={ui.newMeeting.notDraftTitle}>
          <p>{ui.newMeeting.notDraftBody}</p>
        </Notice>
      )}

      {isDraft ? (
        <SectionCard
          title={ui.newMeeting.deleteTitle}
          description={ui.newMeeting.deleteExplain}
          actions={
            canDelete ? (
              <ButtonLink
                href={`${meetingHref}?dialog=delete`}
                variant="danger"
                size="sm"
                className="print:hidden"
              >
                {ui.newMeeting.deleteConfirm}
              </ButtonLink>
            ) : (
              <span className="text-[12px] text-slate-400">{ui.common.notAvailable}</span>
            )
          }
        >
          <p className="text-[13px] text-slate-600">
            {`This draft holds ${detail.counts.segments} transcript ${
              detail.counts.segments === 1 ? 'line' : 'lines'
            } and ${detail.stats.decisions + detail.stats.tasks} record${
              detail.stats.decisions + detail.stats.tasks === 1 ? '' : 's'
            }.`}
          </p>
        </SectionCard>
      ) : null}

      {single('dialog') === 'delete' && isDraft ? (
        <ConfirmAction
          title={ui.newMeeting.deleteConfirm}
          description={ui.newMeeting.deleteTitle}
          confirmLabel={ui.writes.delete}
          action={deleteMeetingDraftAction}
          fields={[
            { name: 'workspaceId', value: workspaceId },
            { name: 'meetingId', value: meetingId },
          ]}
          closeHref={meetingHref}
          canWrite={canDelete}
          warning={ui.newMeeting.deleteExplain}
        />
      ) : null}
    </div>
  );
}
