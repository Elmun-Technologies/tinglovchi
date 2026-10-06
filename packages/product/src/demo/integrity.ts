import type { EvidenceRef, MeetingSummary, TranscriptSegment } from '../domain';
import type { DemoDataset } from './dataset';

/**
 * Independent verification of the assembled demo dataset.
 *
 * This is deliberately *not* the builder re-running its own logic: it recomputes expectations from the
 * assembled objects and compares. It is exported so a test can fail the build on any dangling reference, and
 * so the web app can surface it in development instead of shipping a broken demo.
 */
export type IntegrityIssue = { path: string; message: string };

const QUOTE_LIMIT = 220;

function quoteOf(segments: TranscriptSegment[]): string {
  const joined = segments.map((segment) => segment.text).join(' ');
  return joined.length > QUOTE_LIMIT ? `${joined.slice(0, QUOTE_LIMIT - 1)}…` : joined;
}

export function demoIntegrityIssues(dataset: DemoDataset): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  const meetingIds = new Set(dataset.meetings.map((meeting) => meeting.id));
  const personIds = new Set(dataset.people.map((individual) => individual.id));
  const companyIds = new Set(dataset.companies.map((company) => company.id));
  const projectIds = new Set(dataset.projects.map((project) => project.id));
  const meetingTypeIds = new Set(dataset.meetingTypes.map((type) => type.id));

  if (meetingIds.size !== dataset.meetings.length) push('meetings', 'duplicate meeting ids');

  const segmentsOf = new Map<string, TranscriptSegment[]>();
  for (const meeting of dataset.meetings) {
    const transcript = dataset.transcripts[meeting.id];
    if (!transcript) {
      push(meeting.id, 'no transcript entry');
      segmentsOf.set(meeting.id, []);
      continue;
    }
    segmentsOf.set(meeting.id, transcript.segments);
    const seen = new Set<string>();
    let previousEnd = -1;
    for (const segment of transcript.segments) {
      if (seen.has(segment.id)) push(`${meeting.id}/${segment.id}`, 'duplicate segment id');
      seen.add(segment.id);
      if (
        segment.index !== transcript.segments.indexOf(segment) &&
        transcript.segments[segment.index]?.id !== segment.id
      ) {
        push(`${meeting.id}/${segment.id}`, `index ${segment.index} does not match position`);
      }
      if (segment.startMs >= segment.endMs)
        push(`${meeting.id}/${segment.id}`, 'start is not before end');
      if (segment.startMs < previousEnd)
        push(`${meeting.id}/${segment.id}`, 'overlaps the previous segment');
      previousEnd = segment.endMs;
      if (segment.endMs > meeting.durationMs)
        push(`${meeting.id}/${segment.id}`, 'ends after the meeting duration');
      if (segment.meetingId !== meeting.id)
        push(`${meeting.id}/${segment.id}`, 'points at another meeting');
      if (segment.speakerPersonId !== null && !personIds.has(segment.speakerPersonId)) {
        push(`${meeting.id}/${segment.id}`, `unknown speaker ${segment.speakerPersonId}`);
      }
    }
    for (const participant of meeting.participants) {
      if (!personIds.has(participant.personId))
        push(`${meeting.id}/participants`, `unknown person ${participant.personId}`);
    }
    for (const mapping of transcript.speakerMappings) {
      const unmapped = mapping.personId === null;
      const hasParticipant = meeting.participants.some(
        (participant) => participant.speakerLabel === mapping.label,
      );
      if (unmapped === hasParticipant) {
        push(
          `${meeting.id}/speakerMappings/${mapping.label}`,
          'unmapped label must have no participant entry, and vice versa',
        );
      }
    }
  }

  const checkEvidence = (path: string, evidence: EvidenceRef[], meetingId: string) => {
    if (evidence.length === 0) {
      push(path, 'no evidence — every analysis artifact must cite its source');
      return;
    }
    for (const ref of evidence) {
      if (!meetingIds.has(ref.meetingId)) {
        push(path, `evidence cites unknown meeting ${ref.meetingId}`);
        continue;
      }
      const segments = segmentsOf.get(ref.meetingId) ?? [];
      const byId = new Map(segments.map((segment) => [segment.id, segment]));
      const resolved = ref.segmentIds.map((id) => byId.get(id));
      if (resolved.some((segment) => !segment)) {
        push(
          path,
          `evidence cites missing segments: ${ref.segmentIds.filter((id) => !byId.has(id)).join(', ')}`,
        );
        continue;
      }
      const all = resolved.filter((segment): segment is TranscriptSegment => Boolean(segment));
      if (all[0] && all[0].startMs !== ref.startMs)
        push(path, 'evidence startMs does not match its first segment');
      const last = all.at(-1);
      if (last && last.endMs !== ref.endMs)
        push(path, 'evidence endMs does not match its last segment');
      if (ref.endMs < ref.startMs) push(path, 'evidence range is inverted');
      if (quoteOf(all) !== ref.quote)
        push(path, 'evidence quote does not match the cited segments');
      const speakers = new Set(
        all.map((segment) => segment.speakerPersonId).filter((id): id is string => id !== null),
      );
      if (
        speakers.size !== new Set(ref.speakerPersonIds).size ||
        [...speakers].some((id) => !ref.speakerPersonIds.includes(id))
      ) {
        push(path, 'evidence speakers do not match the cited segments');
      }
      const meeting = dataset.meetings.find((item) => item.id === meetingId);
      if (meeting && ref.meetingTitle !== meeting.title)
        push(path, 'evidence title disagrees with the meeting');
      if (meeting && ref.occurredAt !== meeting.occurredAt)
        push(path, 'evidence date disagrees with the meeting');
    }
  };

  const requireScope = (
    path: string,
    item: {
      meetingId: string;
      companyId: string | null;
      projectId?: string | null;
      workspaceId: string;
    },
  ) => {
    const meeting = dataset.meetings.find((entry) => entry.id === item.meetingId);
    if (!meeting) {
      push(path, `unknown meeting ${item.meetingId}`);
      return;
    }
    if (item.workspaceId !== meeting.workspaceId) push(path, 'workspace mismatch with its meeting');
    if (item.companyId !== meeting.companyId) push(path, 'company does not match its meeting');
    if (item.projectId !== meeting.projectId) push(path, 'project does not match its meeting');
    if (item.companyId && !companyIds.has(item.companyId))
      push(path, `unknown company ${item.companyId}`);
    if (item.projectId && !projectIds.has(item.projectId))
      push(path, `unknown project ${item.projectId}`);
    if (!meetingTypeIds.has(meeting.meetingTypeId))
      push(path, 'meeting references an unknown meeting type');
  };

  const topicIdsByMeeting = new Map<string, Set<string>>();
  for (const [meetingId, topics] of Object.entries(dataset.topicsByMeeting)) {
    topicIdsByMeeting.set(meetingId, new Set(topics.map((topic) => topic.id)));
    const segments = segmentsOf.get(meetingId) ?? [];
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    for (const topic of topics) {
      const path = `topics/${topic.id}`;
      if (topic.segmentIds.length === 0) push(path, 'topic has no transcript segments');
      if (topic.segmentIds.some((id) => !byId.has(id)))
        push(path, 'topic cites a segment that does not exist');
      if (topic.parentId && !topicIdsByMeeting.get(meetingId)?.has(topic.parentId))
        push(path, 'orphan topic parent');
      if (topic.endMs < topic.startMs) push(path, 'inverted time range');
      for (const personId of topic.participantPersonIds) {
        if (!personIds.has(personId)) push(path, `unknown participant ${personId}`);
      }
    }
    // Siblings must not fight over the same segments.
    const children = new Map<string | null, typeof topics>();
    for (const topic of topics) {
      const list = children.get(topic.parentId) ?? [];
      list.push(topic);
      children.set(topic.parentId, list);
    }
    for (const [parentId, siblings] of children) {
      for (let left = 0; left < siblings.length; left += 1) {
        for (let right = left + 1; right < siblings.length; right += 1) {
          const shared = siblings[left]!.segmentIds.filter((id) =>
            siblings[right]!.segmentIds.includes(id),
          );
          if (shared.length > 0) {
            push(
              `topics/${parentId ?? 'root'}`,
              `siblings "${siblings[left]!.title}" and "${siblings[right]!.title}" share ${shared.length} segments`,
            );
          }
        }
      }
    }
  }

  const decisionIds = new Set(dataset.decisions.map((decision) => decision.id));
  for (const decision of dataset.decisions) {
    const path = `decisions/${decision.id}`;
    requireScope(path, decision);
    checkEvidence(path, decision.evidence, decision.meetingId);
    if (decision.topicId && !topicIdsByMeeting.get(decision.meetingId)?.has(decision.topicId)) {
      push(path, `unknown topic ${decision.topicId}`);
    }
    for (const personId of decision.participantPersonIds) {
      if (!personIds.has(personId)) push(path, `unknown participant ${personId}`);
    }
    if (decision.status === 'superseded') {
      if (!decision.supersededByDecisionId) push(path, 'superseded without a superseding decision');
      else if (!decisionIds.has(decision.supersededByDecisionId))
        push(path, 'superseding decision does not exist');
    } else if (decision.supersededByDecisionId) {
      push(path, 'supersededByDecisionId set on a non-superseded decision');
    }
    const topic = (dataset.topicsByMeeting[decision.meetingId] ?? []).find(
      (item) => item.id === decision.topicId,
    );
    if (topic && !topic.decisionIds.includes(decision.id))
      push(path, 'topic does not list this decision');
    const followUps = dataset.tasks.filter(
      (task) =>
        task.meetingId === decision.meetingId &&
        (decision.topicId === null || task.topicId === decision.topicId),
    );
    if (decision.hasFollowUpTasks !== followUps.length > 0)
      push(path, 'hasFollowUpTasks disagrees with the task list');
  }

  for (const task of dataset.tasks) {
    const path = `tasks/${task.id}`;
    requireScope(path, task);
    checkEvidence(path, task.evidence, task.meetingId);
    if (task.ownerPersonId && !personIds.has(task.ownerPersonId))
      push(path, `unknown owner ${task.ownerPersonId}`);
    const owner = dataset.people.find((item) => item.id === task.ownerPersonId);
    if (task.ownerLabel !== (owner?.name ?? 'Unassigned'))
      push(path, 'ownerLabel disagrees with ownerPersonId');
    if (task.status === 'completed' && !task.completedAt)
      push(path, 'completed without completedAt');
    if (task.status !== 'completed' && task.completedAt)
      push(path, 'completedAt on an unfinished task');
    if (task.dueDate && task.dueDate < task.createdAt.slice(0, 10) && task.status !== 'completed') {
      push(path, 'deadline is before the meeting that created it');
    }
    const topic = (dataset.topicsByMeeting[task.meetingId] ?? []).find(
      (item) => item.id === task.topicId,
    );
    if (task.topicId && !topic) push(path, `unknown topic ${task.topicId}`);
    if (topic && !topic.taskIds.includes(task.id)) push(path, 'topic does not list this task');
  }

  for (const fact of dataset.facts) {
    const path = `facts/${fact.id}`;
    requireScope(path, fact);
    checkEvidence(path, fact.evidence, fact.meetingId);
    if (fact.speakerPersonId && !personIds.has(fact.speakerPersonId)) push(path, 'unknown speaker');
  }

  for (const question of dataset.questions) {
    const path = `questions/${question.id}`;
    requireScope(path, question);
    checkEvidence(path, question.evidence, question.meetingId);
    if (question.askedByPersonId && !personIds.has(question.askedByPersonId))
      push(path, 'unknown asker');
    if (question.status === 'answered' && !question.resolution)
      push(path, 'answered without a resolution');
    if (question.status !== 'answered' && question.resolution)
      push(path, 'resolution on an unanswered question');
    if (question.resolution)
      checkEvidence(`${path}/resolution`, question.resolution.evidence, question.meetingId);
  }

  for (const idea of dataset.ideas) {
    const path = `ideas/${idea.id}`;
    requireScope(path, idea);
    checkEvidence(path, idea.evidence, idea.meetingId);
    if (!personIds.has(idea.proposedByPersonId)) push(path, 'unknown proposer');
  }

  for (const commitment of dataset.commitments) {
    const path = `commitments/${commitment.id}`;
    requireScope(path, commitment);
    checkEvidence(path, commitment.evidence, commitment.meetingId);
    if (!personIds.has(commitment.byPersonId)) push(path, 'unknown committer');
  }

  for (const meeting of dataset.meetings) {
    const path = `meetings/${meeting.id}`;
    if (meeting.capturedMs !== null && meeting.capturedMs > meeting.durationMs) {
      push(path, 'captured duration exceeds canonical duration');
    }
    if (!meetingTypeIds.has(meeting.meetingTypeId)) push(path, 'unknown meeting type');
    if (meeting.companyId && !companyIds.has(meeting.companyId)) push(path, 'unknown company');
    if (meeting.projectId && !projectIds.has(meeting.projectId)) push(path, 'unknown project');
    const project = dataset.projects.find((item) => item.id === meeting.projectId);
    if (project && project.companyId !== meeting.companyId)
      push(path, 'project belongs to a different company than the meeting');
    const recount = (kind: 'decisions' | 'tasks' | 'facts' | 'questions' | 'ideas') =>
      dataset[kind].filter((item) => item.meetingId === meeting.id).length;
    const expected = {
      topics: (dataset.topicsByMeeting[meeting.id] ?? []).length,
      decisions: recount('decisions'),
      tasks: recount('tasks'),
      facts: recount('facts'),
      questions: recount('questions'),
      ideas: recount('ideas'),
      segments: dataset.transcripts[meeting.id]?.segments.length ?? 0,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (meeting.counts[key as keyof typeof expected] !== value) {
        push(
          path,
          `count ${key} = ${meeting.counts[key as keyof typeof expected]} but children say ${value}`,
        );
      }
    }
    const detail = dataset.details[meeting.id];
    if (!detail) push(path, 'no detail record');
    else {
      if (detail.title !== meeting.title || detail.occurredAt !== meeting.occurredAt)
        push(path, 'detail disagrees with summary');
      if (detail.stats.words !== (dataset.transcripts[meeting.id]?.wordCount ?? 0))
        push(path, 'word count disagrees with transcript');
      const expectedSpeakers = new Set(
        (dataset.transcripts[meeting.id]?.segments ?? []).map(
          (segment) => segment.speakerPersonId ?? segment.speakerLabel,
        ),
      ).size;
      if (detail.stats.speakingParticipants !== expectedSpeakers)
        push(path, 'speakingParticipants disagrees with transcript');
    }
  }

  // Dashboard totals must equal a recount of the same fixtures.
  const isOpen = (status: string) =>
    status === 'open' || status === 'in_progress' || status === 'blocked';
  const overdue = (due: string | null, status: string) =>
    isOpen(status) && due !== null && due < dataset.todayIsoDate;
  const dashboard = dataset.dashboard;
  if (dashboard.openTaskCount !== dataset.tasks.filter((task) => isOpen(task.status)).length) {
    push('dashboard', 'openTaskCount disagrees with the task list');
  }
  if (
    dashboard.overdueTaskCount !==
    dataset.tasks.filter((task) => overdue(task.dueDate, task.status)).length
  ) {
    push('dashboard', 'overdueTaskCount disagrees with the task list');
  }
  if (dashboard.meetingCount !== dataset.meetings.length)
    push('dashboard', 'meetingCount disagrees with the meeting list');
  const todayMeetings = dataset.meetings.filter(
    (meeting) => meeting.occurredAt.slice(0, 10) === dataset.todayIsoDate,
  ).length;
  if (dashboard.todayMeetings.length !== todayMeetings)
    push('dashboard', 'todayMeetings disagrees with the meeting list');

  for (const member of dataset.settings.members) {
    if (!personIds.has(member.personId))
      push(`settings/members/${member.personId}`, 'member without a person record');
  }
  for (const [meetingId, timeline] of Object.entries(dataset.processing)) {
    const meeting = dataset.meetings.find((item) => item.id === meetingId) as
      MeetingSummary | undefined;
    if (!meeting) push(`processing/${meetingId}`, 'unknown meeting');
    else if (timeline.state !== meeting.state)
      push(`processing/${meetingId}`, 'state disagrees with the meeting');
    const failed = timeline.steps.filter((step) => step.state === 'failed').length;
    if (failed > 0 && !timeline.error)
      push(`processing/${meetingId}`, 'a failed step with no error explanation');
    if (failed === 0 && timeline.error)
      push(`processing/${meetingId}`, 'an error with no failed step');
  }

  return issues;
}

export function assertDemoIntegrity(dataset: DemoDataset): void {
  const issues = demoIntegrityIssues(dataset);
  if (issues.length > 0) {
    const list = issues
      .slice(0, 20)
      .map((issue) => `  • ${issue.path}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `demo fixture integrity failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${list}`,
    );
  }
}
