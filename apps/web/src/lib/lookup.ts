import type { MeetingSummary, Participant, ProductRepositories } from '@suhbat/product';
import { evidenceLinker, type EvidenceLinker, type PersonName } from './hrefs';

/**
 * Cross-record lookups a page needs to render denormalised ids as names.
 *
 * The repository contract keeps `Person` out of most payloads — records carry ids plus the labels needed to
 * render them (`ownerLabel`, `meetingTitle`) — so a page that wants a face next to every id asks once, here,
 * instead of N times in a map.
 */
export type Lookup = {
  companies: Map<string, string>;
  projects: Map<string, string>;
  people: Map<string, PersonName>;
  /** Person → participant metadata, for avatars where only a meeting knows the kind. */
  participants: Map<string, Participant>;
  meetings: Map<string, MeetingSummary>;
  evidence: EvidenceLinker;
  /** Evidence-based name resolution for a card that only knows speaker ids. */
  nameOf: (personId: string | null | undefined) => string | undefined;
};

export async function buildLookup(
  repositories: ProductRepositories,
  workspaceId: string,
): Promise<Lookup> {
  const [companies, projects, rows] = await Promise.all([
    // Names are resolved for every record, including archived ones: a meeting's company must still be
    // readable after that company leaves the default list.
    repositories.companies.list(workspaceId, { includeArchived: true }),
    repositories.projects.list(workspaceId, { includeArchived: true }),
    repositories.meetings.list(workspaceId),
  ]);
  const people = new Map<string, PersonName>();
  const participants = new Map<string, Participant>();
  const meetings = new Map<string, MeetingSummary>();
  for (const row of rows) {
    meetings.set(row.meeting.id, row.meeting);
    for (const participant of row.meeting.participants) {
      participants.set(participant.personId, participant);
      // A participant is enough to render a name; the full person profile is not needed for that.
      if (!people.has(participant.personId))
        people.set(participant.personId, { name: participant.name });
    }
  }
  return {
    companies: new Map(companies.map((company) => [company.id, company.name])),
    projects: new Map(projects.map((project) => [project.id, project.name])),
    people,
    participants,
    meetings,
    evidence: evidenceLinker(workspaceId, people),
    nameOf: (personId) => (personId ? people.get(personId)?.name : undefined),
  };
}

/** Meeting titles for evidence that points at a meeting the current page is not about. */
export function meetingTitleOf(meetings: Map<string, MeetingSummary>, meetingId: string): string {
  return meetings.get(meetingId)?.title ?? 'Meeting';
}
