import {
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  SectionCard,
  Select,
  Textarea,
  MeetingStatusBadge,
} from '@suhbat/ui';
import { can, routes } from '@suhbat/product';
import { getCapabilities, getRepositories } from '../../../../../lib/repositories';
import { readFlash } from '../../../../../lib/feedback';
import { saveMeetingDraftAction } from '../../../../actions/product';
import { ui } from '../../../../../copy/ui-copy';

export const metadata = { title: ui.newMeeting.title };

/**
 * The recording entry point. It collects the meeting's context and then says honestly what this surface can do:
 * a browser page does not capture audio here, so "Start recording" hands off to the desktop app and the draft
 * path is only offered when the active adapter can actually write one.
 */
export default async function NewMeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const flash = readFlash(query);
  const repositories = getRepositories();
  const [companies, projects, types, settings, recorder] = await Promise.all([
    repositories.companies.list(workspaceId),
    repositories.projects.list(workspaceId),
    repositories.meetings.meetingTypes(workspaceId),
    repositories.settings.get(workspaceId),
    repositories.desktop.status(),
  ]);
  // The capability record, not the shape of the adapter: a live placeholder object has a method for every
  // name, so `typeof` would have been a lie here.
  const canCreateDraft = can(getCapabilities(), 'meeting.draft.create');

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title={ui.newMeeting.title}
        description={ui.newMeeting.intro}
        breadcrumbs={[
          { label: ui.nav.meetings, href: routes.meetings({ workspaceId }) },
          { label: ui.newMeeting.title },
        ]}
        actions={
          <ButtonLink href={routes.meetings({ workspaceId })} variant="ghost" size="sm">
            {ui.common.back}
          </ButtonLink>
        }
      />
      {flash ? (
        <Notice tone={flash.tone} title={flash.title}>
          {flash.body}
        </Notice>
      ) : null}

      <Notice
        tone={recorder.state === 'available' ? 'info' : 'warning'}
        title={ui.newMeeting.recordTitle}
        actions={
          <ButtonLink
            href={recorder.deepLink}
            variant="secondary"
            size="sm"
            title={recorder.detail}
          >
            {ui.newMeeting.openDesktop}
          </ButtonLink>
        }
      >
        <p>{ui.newMeeting.recordBody}</p>
        <p className="font-mono text-[11.5px] text-slate-500">{recorder.detail}</p>
      </Notice>

      <form action={saveMeetingDraftAction} className="space-y-5">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="next" value={routes.meetings({ workspaceId })} />

        <SectionCard
          title={`Step 1 — ${ui.newMeeting.steps.company}`}
          description={ui.newMeeting.companyLabel}
        >
          <Field id="company" label={ui.newMeeting.companyLabel} hint={ui.newMeeting.companyHint}>
            <Select id="company" name="companyId" defaultValue="" disabled={!canCreateDraft}>
              <option value="">{ui.common.noCompany}</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
        </SectionCard>

        <SectionCard
          title={`Step 2 — ${ui.newMeeting.steps.project}`}
          description={ui.newMeeting.projectLabel}
        >
          <Field id="project" label={ui.newMeeting.projectLabel} hint={ui.newMeeting.projectHint}>
            <Select id="project" name="projectId" defaultValue="" disabled={!canCreateDraft}>
              <option value="">{ui.common.all}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
        </SectionCard>

        <SectionCard
          title={`Step 3 — ${ui.newMeeting.steps.title}`}
          description={ui.newMeeting.titleLabel}
        >
          <Field id="title" label={ui.newMeeting.titleLabel} hint={ui.newMeeting.validation}>
            <Input
              id="title"
              name="title"
              placeholder={ui.newMeeting.titlePlaceholder}
              minLength={2}
              maxLength={180}
              required={canCreateDraft}
              disabled={!canCreateDraft}
            />
          </Field>
          {/* When and how long are planned facts about a conversation that has not happened. They are captured
              separately from any recording, so nothing here implies audio was taken. */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field id="occurredAt" label={ui.newMeeting.whenLabel} hint={ui.writes.whenHint}>
              <Input
                id="occurredAt"
                name="occurredAt"
                type="datetime-local"
                disabled={!canCreateDraft}
                className="sm:col-span-1"
              />
            </Field>
            <Field
              id="durationMinutes"
              label={ui.newMeeting.durationLabel}
              hint={ui.writes.durationHint}
            >
              <Input
                id="durationMinutes"
                name="durationMinutes"
                type="number"
                min={5}
                max={1440}
                step={5}
                placeholder="45"
                disabled={!canCreateDraft}
              />
            </Field>
          </div>
          <Field
            id="notes"
            label={ui.newMeeting.notesLabel}
            hint={ui.writes.notesHint}
            className="mt-3"
          >
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              maxLength={2000}
              placeholder={ui.newMeeting.notesPlaceholder}
              disabled={!canCreateDraft}
            />
          </Field>
        </SectionCard>

        <SectionCard
          title={`Step 4 — ${ui.newMeeting.steps.type}`}
          description={ui.newMeeting.typeLabel}
        >
          <Field id="meetingTypeId" label={ui.newMeeting.typeLabel}>
            <Select
              id="meetingTypeId"
              name="meetingTypeId"
              defaultValue={types[0]?.id ?? ''}
              disabled={!canCreateDraft}
            >
              {types
                .filter((type) => type.active)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.displayName}
                  </option>
                ))}
            </Select>
          </Field>
        </SectionCard>

        <SectionCard
          title={`Step 5 — ${ui.newMeeting.steps.participants}`}
          description={ui.newMeeting.participantsLabel}
        >
          <p className="mb-2 text-[12.5px] text-slate-500">{ui.newMeeting.participantsHint}</p>
          <fieldset disabled={!canCreateDraft}>
            <legend className="sr-only">{ui.newMeeting.participantsLabel}</legend>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {settings.members.map((member) => (
                <li key={member.personId}>
                  <label className="flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50 has-checked:border-teal-700/40 has-checked:bg-teal-50/60">
                    <input
                      type="checkbox"
                      name="participantIds"
                      value={member.personId}
                      defaultChecked={member.personId === settings.members[0]?.personId}
                      className="size-4 accent-teal-700"
                    />
                    <span className="min-w-0 flex-1 truncate">{member.name}</span>
                    <span className="shrink-0 text-[11.5px] text-slate-400">{member.role}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </SectionCard>

        <SectionCard
          title={`Step 6 — ${ui.newMeeting.steps.record}`}
          description={ui.newMeeting.startRecording}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              disabled
              title={ui.newMeeting.recordingClaim}
              aria-disabled="true"
            >
              {ui.newMeeting.startRecording}
            </Button>
            {/* When the draft cannot be written there is no submit button to render — and a disabled one, so an
                Enter key in a field has nothing to implicitly submit against. */}
            <Button
              type="submit"
              variant="secondary"
              disabled={!canCreateDraft}
              title={canCreateDraft ? undefined : ui.newMeeting.draftBlocked}
            >
              {ui.newMeeting.createDraft}
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] text-slate-500">
            {canCreateDraft ? ui.newMeeting.recordingClaim : ui.newMeeting.draftBlocked}
          </p>
        </SectionCard>
      </form>

      {!canCreateDraft ? (
        <SectionCard
          title="What a draft looks like"
          description="A draft holds a place for a meeting that has not been captured. Nothing was invented for it."
        >
          <DraftPreview workspaceId={workspaceId} repositories={repositories} />
        </SectionCard>
      ) : null}
    </div>
  );
}

async function DraftPreview({
  workspaceId,
  repositories,
}: {
  workspaceId: string;
  repositories: ReturnType<typeof getRepositories>;
}) {
  const rows = await repositories.meetings.list(workspaceId, { state: 'draft' });
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No draft in the fixtures"
        description="Every demo meeting has been captured or queued."
        icon="file"
      />
    );
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.meeting.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <a
            href={routes.meeting({ workspaceId, meetingId: row.meeting.id })}
            className="font-medium text-slate-900 hover:text-teal-900"
          >
            {row.meeting.title}
          </a>
          <MeetingStatusBadge state={row.meeting.state} />
          <span className="text-slate-500">
            {row.meeting.companyName ?? ui.common.noCompany} · nothing captured yet
          </span>
        </li>
      ))}
    </ul>
  );
}
