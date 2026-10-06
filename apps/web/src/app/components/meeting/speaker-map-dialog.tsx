'use client';

import { useRouter } from 'next/navigation';
import { Button, Field, Modal, Notice, Select } from '@suhbat/ui';
import { ui } from '../../../copy/ui-copy';
import { confirmSpeakerMappingAction } from '../../actions/product';

/**
 * Speaker mapping dialog: assign a diarization label to a person.
 *
 * It is a client island for exactly two reasons — opening a native dialog and closing it by navigating back to a
 * URL without the `map` param. The write itself is a POST to a server action, which refuses when the active
 * adapter cannot persist it. There is no voice analysis anywhere in this flow: the list is the workspace roster,
 * and the label is text.
 */
export function SpeakerMapDialog({
  workspaceId,
  meetingId,
  label,
  people,
  closeHref,
  canWrite,
}: {
  workspaceId: string;
  meetingId: string;
  label: string;
  people: { personId: string; name: string }[];
  closeHref: string;
  canWrite: boolean;
}) {
  // The dialog is open because `?map=` is in the URL, so closing it means removing that param — the URL stays
  // the single source of truth, and a reload cannot leave a stale dialog on screen.
  const router = useRouter();

  return (
    <Modal
      title={ui.speakers.dialogTitle}
      description={ui.speakers.dialogIntro}
      onDismiss={() => router.replace(closeHref)}
      labelledById="speaker-map-title"
      footer={
        <>
          <button
            type="button"
            onClick={() => router.replace(closeHref)}
            className="inline-flex min-h-9 items-center rounded-lg px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
          >
            {ui.speakers.cancel}
          </button>
          <Button type="submit" form="speaker-map-form" size="sm" disabled={!canWrite}>
            {ui.speakers.confirm}
          </Button>
        </>
      }
    >
      <form id="speaker-map-form" action={confirmSpeakerMappingAction}>
        <input type="hidden" name="meetingId" value={meetingId} />
        <input type="hidden" name="label" value={label} />
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input
          type="hidden"
          name="next"
          value={`/w/${workspaceId}/meetings/${meetingId}/transcript`}
        />
        <div className="space-y-3">
          <Field id="speaker-map-label" label={ui.speakers.label}>
            <input
              id="speaker-map-label"
              value={label}
              readOnly
              className="min-h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800"
            />
          </Field>
          <Field id="speaker-map-person" label={ui.speakers.person} hint={ui.speakers.mappedNotice}>
            <Select
              id="speaker-map-person"
              name="personId"
              data-autofocus
              defaultValue={people[0]?.personId ?? ''}
              disabled={!canWrite}
            >
              {people.map((person) => (
                <option key={person.personId} value={person.personId}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
          {!canWrite ? (
            <Notice tone="warning" title={ui.common.notAvailable}>
              <p>{ui.speakers.unavailable}</p>
            </Notice>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
