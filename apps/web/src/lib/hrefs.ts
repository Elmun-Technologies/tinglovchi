import { routes, type EvidenceRef } from '@suhbat/product';

/**
 * Href plumbing for the product surface. Components never build paths: they receive `hrefOf`/`namesOf` from the
 * page, which is where the workspace scope is known. Keeping it here means a citation behaves identically on
 * a decision card, a task row and an Ask AI source card.
 */

export type LinkScope = { workspaceId: string; meetingId?: string };

export function evidenceHref(workspaceId: string, evidence: EvidenceRef): string {
  const first = evidence.segmentIds[0];
  if (!first) {
    // No segment ids means the citation can only take a person to the transcript tab, not to a line.
    return routes.meetingTab({ workspaceId, meetingId: evidence.meetingId, tab: 'transcript' });
  }
  return routes.evidence({
    workspaceId,
    meetingId: evidence.meetingId,
    segmentId: first,
    startMs: evidence.startMs,
  });
}

export function transcriptHref(
  workspaceId: string,
  meetingId: string,
  params?: Record<string, string | number | undefined>,
): string {
  return routes.meetingTab({ workspaceId, meetingId, tab: 'transcript' }, params);
}

/** Just enough of a person to name them: an unmapped speaker has no profile to look up. */
export type PersonName = { name: string };

export type EvidenceLinker = {
  hrefOf: (evidence: EvidenceRef) => string;
  namesOf: (evidence: EvidenceRef) => string[];
};

/**
 * Builds the two functions every evidence-bearing component wants. `people` maps a person id to a display
 * name; an unmapped speaker renders as its diarization label, which is what the transcript actually says.
 */
export function evidenceLinker(
  workspaceId: string,
  people: Map<string, PersonName> | Record<string, PersonName>,
  fallbackLabel?: (evidence: EvidenceRef) => string | undefined,
): EvidenceLinker {
  const lookup = people instanceof Map ? people : new Map(Object.entries(people));
  return {
    hrefOf: (evidence) => evidenceHref(workspaceId, evidence),
    namesOf: (evidence) =>
      evidence.speakerPersonIds.length > 0
        ? evidence.speakerPersonIds.map((id) => lookup.get(id)?.name ?? id)
        : [fallbackLabel?.(evidence) ?? 'Unmapped speaker'].filter(Boolean),
  };
}

/** Empty-value params are dropped so a filtered URL stays readable and shareable. */
export function cleanParams(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}
