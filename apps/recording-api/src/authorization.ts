import { Phase4ServiceError } from '@suhbat/database/phase4';
import type { SqlExecutor } from '@suhbat/database/phase4';

/**
 * Independent authorization re-checks, performed by the Recording API before it dispatches anything.
 *
 * ## Why re-check here when the service already checks?
 *
 * `Phase4BackboneService` connects with a privileged credential, so PostgreSQL row-level security
 * does not apply to a single statement it issues. Every authorization decision in that layer is
 * therefore application code — and application code is one refactor away from being removed.
 *
 * This service is reachable only from the Web gateway, but "only reachable from" is a network
 * property, not an authorization property. It is the difference between a locked door and a checked
 * badge: we want both. So the Recording API re-derives the answer from the database itself rather
 * than trusting any identifier that arrived with the request:
 *
 *   - `createRecording` gets a `workspaceId` and `meetingId` from the client body. Both are claims.
 *     We confirm the user is an *active* member of the workspace and that the meeting lives in it.
 *   - Recording-scoped operations get a `recordingId` from the path. We load the recording, derive
 *     its workspace and meeting from the row, and confirm membership against what we found — never
 *     against a `workspaceId` the client supplied.
 *
 * Every failure is a 404 unless we are certain the row exists and the caller simply may not see it.
 * Telling a caller "that exists but is not yours" is a free enumeration oracle.
 */

export type AuthorizedRecordingTarget = {
  recordingId: string;
  workspaceId: string;
  meetingId: string;
};

/**
 * True when `userId` holds an active membership in `workspaceId`.
 *
 * Membership status is checked, not just the row's existence: a suspended member still has a row.
 */
export async function assertActiveWorkspaceMembership(
  db: SqlExecutor,
  userId: string,
  workspaceId: string,
): Promise<void> {
  if (!isUuid(userId) || !isUuid(workspaceId)) {
    throw new Phase4ServiceError(404, 'not_found', 'Workspace was not found.');
  }
  const result = await db.query<{ membership_status: string }>(
    `select membership_status::text as membership_status
       from public.workspace_members
      where workspace_id = $1
        and user_id = $2`,
    [workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row || row.membership_status !== 'active') {
    throw new Phase4ServiceError(
      403,
      'unauthorized',
      'Active workspace membership is required for this operation.',
    );
  }
}

/**
 * Confirms the meeting exists, is not deleted or purged, sits in `workspaceId`, and that `userId`
 * may see it.
 */
export async function assertMeetingInWorkspace(
  db: SqlExecutor,
  userId: string,
  workspaceId: string,
  meetingId: string,
): Promise<void> {
  if (!isUuid(meetingId)) {
    throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
  }
  // Membership first: if the user is not in the workspace, the meeting is none of their business and
  // they should not learn whether it exists.
  await assertActiveWorkspaceMembership(db, userId, workspaceId);

  const result = await db.query<{ workspace_id: string; deleted_at: string | null; purge_status: string | null }>(
    `select workspace_id, deleted_at, purge_status
       from public.meetings
      where id = $1`,
    [meetingId],
  );
  const meeting = result.rows[0];
  if (!meeting || meeting.deleted_at !== null || meeting.purge_status === 'purged') {
    throw new Phase4ServiceError(404, 'not_found', 'Meeting was not found.');
  }
  if (meeting.workspace_id !== workspaceId) {
    throw new Phase4ServiceError(
      403,
      'cross_workspace_access_denied',
      'Meeting does not belong to the supplied workspace.',
    );
  }
}

/**
 * Resolves a recording id from the path into an authorized target.
 *
 * `clientWorkspaceId` is accepted only to produce a sharper error for a client that already named a
 * workspace — it is never used as the authority. The workspace comes from the recording row.
 */
export async function assertAuthorizedRecording(
  db: SqlExecutor,
  userId: string,
  recordingId: string,
  clientWorkspaceId?: string,
): Promise<AuthorizedRecordingTarget> {
  if (!isUuid(recordingId)) {
    throw new Phase4ServiceError(404, 'not_found', 'Recording session was not found.');
  }
  const result = await db.query<{
    id: string;
    workspace_id: string;
    meeting_id: string;
    deleted_at: string | null;
    status: string;
  }>(
    `select id, workspace_id, meeting_id, deleted_at, status
       from public.recordings
      where id = $1`,
    [recordingId],
  );
  const recording = result.rows[0];
  if (!recording || recording.deleted_at !== null || recording.status === 'deleted') {
    throw new Phase4ServiceError(404, 'not_found', 'Recording session was not found.');
  }
  if (clientWorkspaceId && clientWorkspaceId !== recording.workspace_id) {
    throw new Phase4ServiceError(
      404,
      'not_found',
      'Recording session was not found in the supplied workspace.',
    );
  }

  try {
    await assertMeetingInWorkspace(db, userId, recording.workspace_id, recording.meeting_id);
  } catch (cause) {
    // The recording exists, but not for this caller. Saying so would confirm its existence, so the
    // answer is identical to the one a made-up id gets. (This is why the workspace id below comes
    // from the row rather than from the request.)
    if (cause instanceof Phase4ServiceError && cause.statusCode === 403) {
      throw new Phase4ServiceError(404, 'not_found', 'Recording session was not found.');
    }
    throw cause;
  }

  return {
    recordingId: recording.id,
    workspaceId: recording.workspace_id,
    meetingId: recording.meeting_id,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
