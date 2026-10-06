import {
  Badge,
  ButtonLink,
  EmptyState,
  FilterBar,
  FilterField,
  FilterSelect,
  FilterTextInput,
  KnowledgeEntryRow,
  Notice,
  PageHeader,
  TabNav,
  type TabItem,
} from '@suhbat/ui';
import {
  knowledgeFilterSchema,
  knowledgeKindLabels,
  relativeDayLabel,
  routes,
  type KnowledgeFilter,
  type KnowledgeKind,
} from '@suhbat/product';
import { getRepositories } from '../../../../lib/repositories';
import { buildLookup } from '../../../../lib/lookup';
import { ui } from '../../../../copy/ui-copy';

export const metadata = { title: ui.knowledge.title };

const kinds: KnowledgeKind[] = ['decision', 'fact', 'topic', 'commitment', 'question'];

/**
 * Workspace knowledge. This is a filtered browse over typed records — decisions, facts, topics, commitments and
 * questions — and the page says so: there is no embedding search in this build, so nothing here claims one.
 */
export default async function KnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const single = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const kindParam = single('kind') ?? '';
  const raw = {
    kinds: (kindParam === ''
      ? []
      : kindParam
          .split(',')
          .filter((kind) => (kinds as string[]).includes(kind))) as KnowledgeKind[],
    query: single('q') ?? '',
    companyId: single('company') || undefined,
    projectId: single('project') || undefined,
    participantId: single('person') || undefined,
    from: single('from') || undefined,
    to: single('to') || undefined,
  };
  const parsed = knowledgeFilterSchema.safeParse(raw);
  const filter: KnowledgeFilter = parsed.success ? parsed.data : { kinds: [] };

  const repositories = getRepositories();
  const [entries, lookup, dashboard, settings] = await Promise.all([
    repositories.knowledge.entries(filter),
    buildLookup(repositories, workspaceId),
    repositories.meetings.dashboard(workspaceId),
    repositories.settings.get(workspaceId),
  ]);
  const today = dashboard.generatedAt.slice(0, 10);
  const scoped = (kind: KnowledgeKind) => entries.filter((entry) => entry.kind === kind).length;
  const hasFilters = Boolean(
    raw.query || raw.companyId || raw.projectId || raw.participantId || raw.from || raw.to,
  );

  const tabs: TabItem[] = [
    {
      id: 'all',
      href: routes.knowledge({ workspaceId }),
      label: ui.common.all,
      count: entries.length,
      active: raw.kinds.length === 0,
    },
    ...kinds.map((kind) => ({
      id: kind,
      href: routes.knowledge({ workspaceId }, { kind }),
      label: knowledgeKindLabels[kind],
      count: raw.kinds.length === 0 && !hasFilters ? undefined : scoped(kind),
      active: raw.kinds.includes(kind),
    })),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={ui.knowledge.title}
        description={ui.knowledge.intro}
        meta={
          <span className="text-[12.5px] text-slate-500">
            {entries.length} {ui.knowledge.count} · {ui.knowledge.note}
          </span>
        }
        actions={
          <ButtonLink href={routes.ask({ workspaceId })} variant="secondary" size="sm">
            {ui.nav.ask}
          </ButtonLink>
        }
      />
      {!parsed.success ? (
        <Notice tone="warning" title="Filter values were ignored">
          <p>
            At least one filter in the address bar is not accepted here, so everything is shown.
          </p>
        </Notice>
      ) : null}

      <TabNav tabs={tabs} />

      <FilterBar
        action={routes.knowledge({ workspaceId })}
        resetHref={routes.knowledge({ workspaceId })}
      >
        <FilterField label={ui.knowledge.search} htmlFor="f-q" className="min-w-[14rem] flex-[2]">
          <FilterTextInput
            id="f-q"
            name="q"
            value={raw.query}
            placeholder={ui.knowledge.searchPlaceholder}
          />
        </FilterField>
        <FilterField label={ui.knowledge.filters.company} htmlFor="f-company">
          <FilterSelect
            id="f-company"
            name="company"
            value={raw.companyId}
            options={[
              { value: '', label: ui.common.all },
              ...[...lookup.companies].map(([value, label]) => ({ value, label })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.knowledge.filters.project} htmlFor="f-project">
          <FilterSelect
            id="f-project"
            name="project"
            value={raw.projectId}
            options={[
              { value: '', label: ui.common.all },
              ...[...lookup.projects].map(([value, label]) => ({ value, label })),
            ]}
          />
        </FilterField>
        <FilterField label={ui.knowledge.filters.participant} htmlFor="f-person">
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
        <FilterField label={ui.knowledge.filters.from} htmlFor="f-from">
          <FilterTextInput id="f-from" name="from" type="date" value={raw.from} />
        </FilterField>
        <FilterField label={ui.knowledge.filters.to} htmlFor="f-to">
          <FilterTextInput id="f-to" name="to" type="date" value={raw.to} />
        </FilterField>
      </FilterBar>

      {entries.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="search"
            title={ui.knowledge.emptyTitle}
            description={ui.knowledge.emptyBody}
            action={
              <ButtonLink href={routes.knowledge({ workspaceId })} size="sm" variant="secondary">
                {ui.common.reset}
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
          {entries.map((entry) => {
            const meeting = lookup.meetings.get(entry.meetingId);
            const evidence = entry.evidence[0];
            return (
              <KnowledgeEntryRow
                key={`${entry.kind}-${entry.id}`}
                kind={entry.kind}
                title={
                  <a
                    href={routes.meetingTab({
                      workspaceId,
                      meetingId: entry.meetingId,
                      tab: tabForKind(entry.kind),
                    })}
                    className="rounded hover:text-teal-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
                  >
                    {entry.title}
                  </a>
                }
                body={entry.body}
                meta={
                  <>
                    <span>{relativeDayLabel(entry.at, today)}</span>
                    {entry.companyId ? (
                      <a
                        href={routes.company({ workspaceId, companyId: entry.companyId })}
                        className="rounded hover:text-slate-900"
                      >
                        {lookup.companies.get(entry.companyId)}
                      </a>
                    ) : null}
                    {entry.projectId ? (
                      <a
                        href={routes.project({ workspaceId, projectId: entry.projectId })}
                        className="rounded hover:text-slate-900"
                      >
                        {lookup.projects.get(entry.projectId)}
                      </a>
                    ) : null}
                    {meeting ? (
                      <a
                        href={routes.meeting({ workspaceId, meetingId: meeting.id })}
                        className="rounded underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
                      >
                        {meeting.title}
                      </a>
                    ) : null}
                    {entry.personIds.map((personId) => (
                      <span key={personId}>{lookup.nameOf(personId) ?? personId}</span>
                    ))}
                    {entry.statusLabel ? <Badge tone="outline">{entry.statusLabel}</Badge> : null}
                  </>
                }
                evidence={evidence}
                hrefOf={lookup.evidence.hrefOf}
                namesOf={lookup.evidence.namesOf}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function tabForKind(
  kind: KnowledgeKind,
): 'overview' | 'decisions' | 'facts' | 'topics' | 'questions' {
  // Commitments live on the meeting Overview tab, which is where their evidence rows are rendered.
  if (kind === 'decision') return 'decisions';
  if (kind === 'fact') return 'facts';
  if (kind === 'topic') return 'topics';
  if (kind === 'question') return 'questions';
  return 'overview';
}
