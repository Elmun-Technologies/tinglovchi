'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from '@suhbat/ui';
import {
  meetingStateLabels,
  meetingStateNotes,
  processingStepLabel,
  type ProcessingTimeline,
} from '@suhbat/product';

/**
 * The banner a deep-linked meeting lands on when the pipeline has not finished.
 *
 * The desktop recorder only offers "Natijani ko‘rish" once the meeting is `ready`, but a link can be
 * opened from a notification, a shared URL, or a second device at any moment. Without this, that
 * landing looks identical to "this meeting produced nothing" — which reads as data loss.
 *
 * Every word here comes from the real `ProcessingTimeline` the server builds. There is no percentage
 * and no estimated time: the pipeline reports named steps, and this shows the last one it named.
 *
 * While the meeting is unfinished the page re-renders itself on an interval, so the result appears
 * without the user having to discover the refresh button. Polling stops once the state is terminal,
 * and pauses while the tab is hidden.
 */

const TERMINAL_STATES = new Set(['ready', 'analysis_failed', 'transcription_failed', 'failed']);
const POLL_INTERVAL_MS = 6_000;

export function MeetingProcessingBanner({ processing }: { processing: ProcessingTimeline | null }) {
  const router = useRouter();

  const state = processing?.state;
  const unfinished = Boolean(state) && !TERMINAL_STATES.has(state!);

  useEffect(() => {
    if (!unfinished) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    timer = setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [unfinished, router, state]);

  if (!processing || (!unfinished && state === 'ready')) return null;

  const failed =
    state === 'analysis_failed' || state === 'transcription_failed' || state === 'failed';
  const active = processing.steps.find((step) => step.state === 'active');
  const failedStep = processing.steps.find((step) => step.state === 'failed');
  const headline = failedStep ?? active ?? processing.steps[processing.steps.length - 1];
  const note = meetingStateNotes[processing.state];

  if (failed) {
    return (
      <Notice tone="warning" title="Suhbat saqlandi. Tahlil vaqtincha bajarilmadi." className="xl:col-span-2">
        <p>Audio serverda saqlangan va o‘chirilmaydi. Natija shu sahifada paydo bo‘ladi.</p>
        {processing.error?.message ? <p>{processing.error.message}</p> : null}
        {headline ? <p className="opacity-80">To‘xtagan bosqich: {processingStepLabel(headline)}.</p> : null}
      </Notice>
    );
  }

  return (
    <Notice tone="info" title={meetingStateLabels[processing.state]} className="xl:col-span-2">
      <p>{note}</p>
      {headline ? <p className="opacity-80">Hozirgi bosqich: {processingStepLabel(headline)}.</p> : null}
    </Notice>
  );
}
