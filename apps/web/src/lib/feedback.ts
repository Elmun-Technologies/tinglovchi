import type { NoticeTone } from '@suhbat/ui';

/**
 * Action results travel as a code in the address bar, and this module turns one into a sentence. That choice
 * is deliberate: a redirect-and-read pattern means the message survives a reload, is shareable, and cannot be
 * shown by a client toast that fired before the write actually happened.
 */
export type Flash = { tone: NoticeTone; title: string; body: string };

const messages: Record<string, Flash> = {
  'state-advanced': {
    tone: 'info',
    title: 'Demo pipeline step advanced',
    body: 'Only the fixture state moved forward. Nothing was transcribed, analysed or indexed.',
  },
  'task-updated': {
    tone: 'success',
    title: 'Task status updated',
    body: 'Held in this dev server’s memory: the demo adapter has no database to write to.',
  },
  'mapping-confirmed': {
    tone: 'success',
    title: 'Speaker mapped',
    body: 'Lines carrying that label now show the person you chose, for this meeting only.',
  },
  'draft-created': {
    tone: 'success',
    title: 'Meeting draft created',
    body: 'A draft exists. Nothing has been recorded, and no recording has started.',
  },
  'record-created': {
    tone: 'success',
    title: 'Saved',
    body: 'Written through the workspace adapter. In demo mode that means this session’s memory: reloading restores the fixtures.',
  },
  'record-updated': {
    tone: 'success',
    title: 'Changes saved',
    body: 'Every screen reads the same record, so the change is already visible here. In demo mode it lives in memory only.',
  },
  'record-archived': {
    tone: 'success',
    title: 'Archived',
    body: 'It is out of the default list and still resolvable by the records that reference it — nothing was deleted.',
  },
  'record-restored': {
    tone: 'success',
    title: 'Restored',
    body: 'The record is back in the default list.',
  },
  'record-deleted': {
    tone: 'success',
    title: 'Draft deleted',
    body: 'Only an unrecorded draft can be deleted. Any meeting with a transcript or records stays, with its evidence.',
  },
  'settings-saved': {
    tone: 'success',
    title: 'Workspace settings saved',
    body: 'Stored in the workspace record this screen reads. In demo mode that is memory for this session, not a cloud profile.',
  },
  'member-invited': {
    tone: 'success',
    title: 'Invitation recorded',
    body: 'The person is listed as invited. Nothing was emailed: this build has no mail provider, and the roster is the only truth here.',
  },
  'member-updated': {
    tone: 'success',
    title: 'Role updated',
    body: 'The roster now reflects the role you chose. Authorization is enforced by the backend, not by this screen.',
  },
  'member-removed': {
    tone: 'success',
    title: 'Member removed',
    body: 'Their records and assignments were left in place; only workspace access changed.',
  },
  'error:validation_failed': {
    tone: 'warning',
    title: 'Input was rejected',
    body: 'The value did not meet the field rules, so nothing was changed.',
  },
  'error:unsupported_in_demo': {
    tone: 'warning',
    title: 'Not available on this data source',
    body: 'The action needs a write path the current adapter does not have. The screen still shows the real state instead of pretending.',
  },
  'error:not_found': {
    tone: 'danger',
    title: 'That record is not in this workspace',
    body: 'The id in the address bar does not belong to a record you can reach here.',
  },
  'error:data_inconsistent': {
    tone: 'danger',
    title: 'Stored data disagrees with itself',
    body: 'A reference could not be resolved. This is reported rather than hidden, because a broken citation would otherwise look like a correct one.',
  },
  'error:provider_unavailable': {
    tone: 'danger',
    title: 'Data source is not reachable',
    body: 'The request failed before it could complete. Retry, and check the provider configuration if it persists.',
  },
  'error:not_configured': {
    tone: 'warning',
    title: 'This workspace is not configured',
    body: 'Required configuration is missing, so the action could not run.',
  },
  'error:unauthorized': {
    tone: 'danger',
    title: 'Not allowed',
    body: 'Your membership in this workspace does not permit that change.',
  },
};

export function readFlash(params: Record<string, string | string[] | undefined>): Flash | null {
  const raw = params.notice ?? params.error;
  const code = Array.isArray(raw) ? raw[0] : raw;
  if (!code) return null;
  const base = messages[code];
  if (!base) return null;
  // A refusal from the adapter explains itself; the generic sentence only appears when nothing did.
  // Only error codes accept a reason, so a crafted link can never dress up a failure as a success.
  const extra = params.reason;
  const reason = (Array.isArray(extra) ? extra[0] : extra)?.trim();
  if (reason && code.startsWith('error:') && reason.length <= 300) return { ...base, body: reason };
  return base;
}
