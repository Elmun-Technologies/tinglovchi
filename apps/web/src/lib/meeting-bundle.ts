import {
  RepositoryError,
  type Decision,
  type Fact,
  type Idea,
  type MeetingDetail,
  type MeetingTab,
  type MeetingTranscript,
  type ProcessingTimeline,
  type ProductRepositories,
  type Question,
  type Task,
  type Topic,
} from '@suhbat/product';

/**
 * One place that assembles everything a meeting tab can ask for, with one workspace-scoped read set.
 *
 * A tab never queries the adapter directly: this keeps the reads identical across tabs (so the Decisions tab and
 * the Overview tab cannot disagree) and keeps a page file short enough to review. Topics arrive with the
 * transcript because that is where speaker mapping and topic attribution are guaranteed to agree.
 */
export type MeetingBundle = {
  detail: MeetingDetail;
  decisions: Decision[];
  tasks: Task[];
  facts: Fact[];
  questions: Question[];
  ideas: Idea[];
  topics: Topic[];
  transcript: MeetingTranscript;
  /** Present for meetings the pipeline has touched, including drafts and failures. */
  processing: ProcessingTimeline | null;
};

export async function loadMeetingBundle(
  repositories: ProductRepositories,
  workspaceId: string,
  meetingId: string,
): Promise<{ ok: true; bundle: MeetingBundle } | { ok: false; error: RepositoryError }> {
  const scope = { workspaceId, meetingId };
  try {
    const [detail, decisions, tasks, facts, questions, ideas, transcript, processing] =
      await Promise.all([
        repositories.meetings.detail(meetingId),
        repositories.meetings.decisionsFor(scope),
        repositories.tasks.list(workspaceId, { meetingId }),
        repositories.meetings.factsFor(scope),
        repositories.meetings.questionsFor(scope),
        repositories.meetings.ideasFor(scope),
        repositories.transcripts.forMeeting(meetingId),
        repositories.meetings.processing(meetingId).catch(() => null),
      ]);
    return {
      ok: true,
      bundle: {
        detail,
        decisions,
        tasks,
        facts,
        questions,
        ideas,
        topics: transcript.topics,
        transcript,
        processing,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof RepositoryError
          ? cause
          : new RepositoryError('provider_unavailable', 'This meeting could not be loaded.', {
              detail: meetingId,
            }),
    };
  }
}

/** Tab badges, always derived from the arrays the tabs render. */
export function tabCounts(bundle: MeetingBundle): Record<MeetingTab, number> {
  return {
    overview: bundle.transcript.segments.length,
    topics: bundle.topics.length,
    transcript: bundle.transcript.segments.length,
    decisions: bundle.decisions.length,
    tasks: bundle.tasks.length,
    facts: bundle.facts.length,
    questions: bundle.questions.length,
    ideas: bundle.ideas.length,
  };
}
