import {
  ButtonLink,
  EmptyState,
  FilterBar,
  FilterField,
  FilterSelect,
  FilterTextInput,
  Notice,
  PageHeader,
} from '@suhbat/ui';
import {
  loadAll,
  meetingFilterSchema,
  RepositoryError,
  routes,
  type MeetingFilter,
} from '@suhbat/product';
import { formatDuration } from '@suhbat/product';
import { getRepositories } from '../../../../lib/repositories';
import { readFlash } from '../../../../lib/feedback';
import { ui } from '../../../../copy/ui-copy';
import { MeetingTable } from '../../../components/meeting-table';

export const metadata = { title: ui.meetings.title };

const statusOptions = [
  { value: '', label: ui.common.all },
  { value: 'draft', label: 'Draft' },
  { value: 'queued', label: 'Queued' },
  { value: 'transcribing', label: 'Transcribing' },
  { value: 'analyzing', label: 'Analyzing' },
  { value: 'indexing', label: 'Indexing' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed', label: 'Needs attention' },
];

/**
 * Meetings index. Filters live in the query string and are applied by the adapter, so the page stays a server
 * component with no client JS, a filtered view is linkable, and "no results" always means "no results for
 * these filters" rather than a swallowed failure.
 */
export default async function MeetingsPage({
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

  const single = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const raw = {
    query: single('q') ?? '',
    companyId: single('company') || undefined,
    projectId: single('project') || undefined,
    meetingTypeId: single('type') || undefined,
    participantId: single('person') || undefined,
    state: single('state') || undefined,
    from: single('from') || undefined,
    to: single('to') || undefined,
  };
  const parsed = meetingFilterSchema.safeParse(raw);
  const filter: MeetingFilter | undefined = parsed.success ? parsed.data : undefined;
  const hasFilters = Object.values(raw).some((value) => value !== '' && value !== undefined);

  const loaded = await loadAll({
    rows: repositories.meetings.list(workspaceId, filter),
    all: repositories.meetings.list(workspaceId),
    companies: repositories.companies.list(workspaceId),
    projects: repositories.projects.list(workspaceId),
    types: repositories.meetings.meetingTypes(workspaceId),
    settings: repositories.settings.get(workspaceId),
  });

  if (!loaded.ok) return <MeetingsError error={loaded.error} />;

  const { rows, all, companies, projects, types, settings } = loaded.data;
  const ready = rows.filter((row) => row.meeting.state === 'ready');
  const minutes = Math.round(ready.reduce((sum, row) => sum + row.meeting.durationMs, 0) / 60_000);
  const decisionTotal = ready.reduce((sum, row) => sum + row.meeting.counts.decisions, 0);
  const openTaskTotal = ready.reduce((sum, row) => sum + row.openTaskCount, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={ui.meetings.title}
        description={ui.meetings.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {rows.length} {rows.length === 1 ? 'meeting' : ui.common.meetings}
            {hasFilters ? ` of ${all.length}` : ''} · {ui.meetings.filteredNotice}
          </span>
        }
        actions={
          <ButtonLink href={routes.newMeeting({ workspaceId })}>{ui.nav.newMeeting}</ButtonLink>
        }
      />
      {flash ? (
        <Notice tone={flash.tone} title={flash.title}>
          {flash.body}
        </Notice>
      ) : null}
      {!parsed.success ? (
        <Notice tone="warning" title="Filter values were ignored">
          <p>
            At least one filter in the address bar is not a value this screen accepts, so the full
            list is shown instead.
          </p>
        </Notice>
      ) : null}

      <FilterBar
        action={routes.meetings({ workspaceId })}
        resetHref={routes.meetings({ workspaceId })}
      >
        <FilterField label={ui.meetings.search} htmlFor="f-q" className="min-w-[14rem] flex-[2]">
          <FilterTextInput
            id="f-q"
            name="q"
            value={raw.query}
            placeholder={ui.meetings.searchPlaceholder}
          />
        </FilterField>
        <FilterField label={ui.meetings.filters.company} htmlFor="f-company">
          <FilterSelect
            id="f-company"
            name="company"
            value={raw.companyId}
            options={[
              { value: '', label: ui.common.all },
              ...companies.map((company) => ({ value: company.id, label: company.name })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.meetings.filters.project} htmlFor="f-project">
          <FilterSelect
            id="f-project"
            name="project"
            value={raw.projectId}
            options={[
              { value: '', label: ui.common.all },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.meetings.filters.type} htmlFor="f-type">
          <FilterSelect
            id="f-type"
            name="type"
            value={raw.meetingTypeId}
            options={[
              { value: '', label: ui.common.all },
              ...types
                .filter((type) => type.active)
                .map((type) => ({ value: type.id, label: type.displayName })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.meetings.filters.participant} htmlFor="f-person">
          <FilterSelect
            id="f-person"
            name="person"
            value={raw.participantId}
            options={[
              { value: '', label: ui.common.all },
              ...settings.members.map((member) => ({ value: member.personId, label: member.name })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.meetings.filters.status} htmlFor="f-state">
          <FilterSelect id="f-state" name="state" value={raw.state} options={statusOptions} />
        </FilterField>
        <FilterField label={ui.meetings.filters.from} htmlFor="f-from">
          <FilterTextInput id="f-from" name="from" type="date" value={raw.from} />
        </FilterField>
        <FilterField label={ui.meetings.filters.to} htmlFor="f-to">
          <FilterTextInput id="f-to" name="to" type="date" value={raw.to} />
        </FilterField>
      </FilterBar>

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[12.5px] text-slate-600 shadow-sm">
        {rows.length === 0
          ? 'No meeting in this view, so there is nothing to total.'
          : `${ready.length} of ${rows.length} analysed · ${decisionTotal} decisions · ${openTaskTotal} open ${
              openTaskTotal === 1 ? 'task' : 'tasks'
            } · ${formatDuration(minutes * 60_000)} of captured conversation counted.`}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon={hasFilters ? 'search' : 'mic'}
            title={hasFilters ? ui.meetings.emptyTitle : ui.meetings.emptyAllTitle}
            description={hasFilters ? ui.meetings.emptyBody : ui.meetings.emptyAllBody}
            action={
              hasFilters ? (
                <ButtonLink href={routes.meetings({ workspaceId })} variant="secondary" size="sm">
                  {ui.common.reset}
                </ButtonLink>
              ) : (
                <ButtonLink href={routes.newMeeting({ workspaceId })} size="sm">
                  {ui.nav.newMeeting}
                </ButtonLink>
              )
            }
          />
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <MeetingTable rows={rows} workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}

function MeetingsError({ error }: { error: RepositoryError }) {
  return (
    <div className="space-y-4">
      <PageHeader title={ui.meetings.title} description={ui.meetings.intro} />
      <Notice tone="danger" title={ui.errors.providerTitle}>
        <p>{error.message}</p>
        {error.hint ? <p className="text-slate-500">{error.hint}</p> : null}
      </Notice>
    </div>
  );
}
