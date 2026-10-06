import {
  RepositoryError,
  exportFormats,
  routes,
  type ExportFormat,
  type MeetingExportInput,
  type ProductRepositories,
} from '@suhbat/product';
import { buildLookup } from './lookup';

/**
 * The single place an export's content is assembled.
 *
 * The print view and the downloadable files are two renderings of the same typed input, built by the same read,
 * which is what keeps a `.md` file from ever saying something the printed page did not. `format` never changes
 * what is collected — only how it is laid out.
 */
export async function loadExportInput(
  repositories: ProductRepositories,
  workspaceId: string,
  meetingId: string,
  options: { includeTranscript: boolean },
): Promise<
  { ok: true; input: MeetingExportInput; title: string } | { ok: false; error: RepositoryError }
> {
  try {
    const scope = { workspaceId, meetingId };
    const [detail, decisions, tasks, facts, questions, ideas, commitments, lookup] =
      await Promise.all([
        repositories.meetings.detail(meetingId),
        repositories.meetings.decisionsFor(scope),
        repositories.tasks.list(workspaceId, { meetingId }),
        repositories.meetings.factsFor(scope),
        repositories.meetings.questionsFor(scope),
        repositories.meetings.ideasFor(scope),
        repositories.meetings.commitmentsFor(scope),
        buildLookup(repositories, workspaceId),
      ]);
    const transcript =
      options.includeTranscript || detail.counts.segments > 0
        ? await repositories.transcripts.forMeeting(meetingId)
        : null;
    return {
      ok: true,
      title: detail.title,
      input: {
        detail,
        decisions,
        // Tasks are scoped by the same read the task board uses, then filtered to this meeting: the adapter's
        // filter is a bucket, not an id, and an export must not inherit someone else's task.
        tasks: tasks.filter((task) => task.meetingId === meetingId),
        facts,
        questions,
        ideas,
        commitments,
        topics: transcript?.topics ?? [],
        transcript: options.includeTranscript ? transcript : null,
        nameOf: lookup.nameOf,
        includeTranscript: options.includeTranscript,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof RepositoryError
          ? cause
          : new RepositoryError(
              'provider_unavailable',
              'This meeting could not be read for export.',
              {
                detail: cause instanceof Error ? cause.message : String(cause),
              },
            ),
    };
  }
}

/** Query string for the same export with the transcript turned on or off. */
export function exportHref(
  workspaceId: string,
  meetingId: string,
  format: 'md' | 'txt' | 'csv' | 'json',
  includeTranscript: boolean,
): string {
  const base = routes.exportMeeting({ workspaceId, meetingId, format });
  return includeTranscript ? `${base}&transcript=1` : base;
}

/**
 * The parts of the download endpoint that decide something rather than fetch something.
 *
 * `?format=` arrives from a URL anyone can type, so it is matched against the formats the product can actually
 * build — an unknown value is a `null` the route turns into a 400, never a guess at what the reader meant. The
 * disposition is built here for the same reason: a filename with a quote in it must not be able to terminate the
 * header and smuggle a second one.
 */
export function parseExportFormat(raw: string | null | undefined): ExportFormat | null {
  const value = (raw ?? '').trim().toLowerCase() || 'md';
  return (exportFormats as readonly string[]).includes(value) ? (value as ExportFormat) : null;
}

/** Only `?transcript=1` attaches a transcript; anything else (including `?transcript`) leaves it out. */
export function transcriptRequested(raw: string | null | undefined): boolean {
  return (raw ?? '').trim() === '1';
}

export function attachmentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/["\r\n]/g, '')}"`;
}
