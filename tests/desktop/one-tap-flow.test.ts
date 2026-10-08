import { describe, expect, it } from 'vitest';
import {
  canPause,
  canResume,
  canStart,
  canStop,
  initialFlowState,
  isCapturing,
  processingHeadline,
  reduceFlow,
  type FlowState,
} from '../../apps/desktop/src/flow.ts';
import { copy, temporaryMeetingTitle } from '../../apps/desktop/src/copy.ts';
import { emptySession, resolveWorkspace } from '../../apps/desktop/src/session-store.ts';
import type { WorkspaceSummaryDto } from '@suhbat/contracts';

/**
 * The one-tap flow, tested as a pure state machine.
 *
 * These are the behaviours a user would notice if they broke: a double-tap producing two recordings, a
 * stop that lands twice, a screen that claims "ready" before the server said so, or a workspace switch
 * mid-meeting that orphans uploaded chunks.
 */

function booted(overrides: Partial<FlowState> = {}): FlowState {
  return reduceFlow(
    { ...initialFlowState, ...overrides },
    { type: 'booted', signedIn: true, workspaceId: 'ws-1', consented: true },
  );
}

describe('boot and sign-in', () => {
  it('opens idle when a session and consent already exist', () => {
    expect(booted().phase).toBe('idle');
  });

  it('opens on the consent screen for a fresh sign-in', () => {
    const state = reduceFlow(initialFlowState, {
      type: 'booted',
      signedIn: true,
      workspaceId: 'ws-1',
      consented: false,
    });
    expect(state.phase).toBe('consent');
  });

  it('opens on sign-in when there is no token', () => {
    const state = reduceFlow(initialFlowState, {
      type: 'booted',
      signedIn: false,
      workspaceId: null,
      consented: false,
    });
    expect(state.phase).toBe('signed_out');
  });

  it('reaches idle only after consent is acknowledged', () => {
    const consent = booted().phase === 'consent' ? booted() : reduceFlow(initialFlowState, {
      type: 'booted',
      signedIn: true,
      workspaceId: 'ws-1',
      consented: false,
    });
    expect(consent.phase).toBe('consent');
    const accepted = reduceFlow(consent, { type: 'consent_acknowledged', workspaceId: 'ws-1' });
    expect(accepted.phase).toBe('idle');
  });

  it('clears the pairing code and local context on sign-out', () => {
    const signedIn = reduceFlow(reduceFlow(initialFlowState, {
      type: 'booted',
      signedIn: true,
      workspaceId: 'ws-1',
      consented: true,
    }), { type: 'pairing_code', code: 'AB12-CDEF-GH34' });
    const out = reduceFlow(signedIn, { type: 'signed_out' });
    expect(out.phase).toBe('signed_out');
    expect(out.pairingCode).toBeNull();
    expect(out.workspaceId).toBeNull();
  });
});

describe('idle → recording', () => {
  it('starts, and only from idle', () => {
    const idle = booted();
    expect(canStart(idle)).toBe(true);
    const starting = reduceFlow(idle, { type: 'start_requested' });
    expect(starting.phase).toBe('starting');
    expect(starting.busy).toBe(true);
    const recording = reduceFlow(starting, { type: 'started', recordingId: 'rec-1' });
    expect(recording.phase).toBe('recording');
    expect(recording.busy).toBe(false);
    expect(recording.recordingId).toBe('rec-1');
  });

  it('drops a duplicate start while one is already in flight', () => {
    const starting = reduceFlow(booted(), { type: 'start_requested' });
    const second = reduceFlow(starting, { type: 'start_requested' });
    expect(second).toBe(starting);
  });

  it('refuses to start without a workspace', () => {
    const noWorkspace = reduceFlow(initialFlowState, {
      type: 'booted',
      signedIn: true,
      workspaceId: null,
      consented: true,
    });
    expect(canStart(noWorkspace)).toBe(false);
    expect(reduceFlow(noWorkspace, { type: 'start_requested' })).toBe(noWorkspace);
  });

  it('returns to idle with a notice when start fails, and never leaves busy set', () => {
    const starting = reduceFlow(booted(), { type: 'start_requested' });
    const failed = reduceFlow(starting, {
      type: 'start_failed',
      notice: { tone: 'error', title: 'Microfon ruxsati kerak' },
    });
    expect(failed.phase).toBe('idle');
    expect(failed.busy).toBe(false);
    expect(failed.notice?.title).toBe('Microfon ruxsati kerak');
  });

  it('ignores a late "started" that arrives after a failure', () => {
    const failed = reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'start_failed',
      notice: { tone: 'error', title: 'x' },
    });
    const late = reduceFlow(failed, { type: 'started', recordingId: 'rec-1' });
    expect(late.phase).toBe('idle');
    expect(late.recordingId).toBeNull();
  });
});

describe('recording → pause → resume', () => {
  it('pauses and resumes on the canonical timeline', () => {
    const recording = reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'started',
      recordingId: 'rec-1',
    });
    expect(canPause(recording)).toBe(true);
    const paused = reduceFlow(recording, { type: 'recorder_state', state: 'paused' });
    expect(paused.phase).toBe('paused');
    expect(canResume(paused)).toBe(true);
    expect(canPause(paused)).toBe(false);
    const resumed = reduceFlow(paused, { type: 'recorder_state', state: 'recording' });
    expect(resumed.phase).toBe('recording');
  });

  it('keeps the timer source in the recorder, not in the reducer', () => {
    // The reducer stores no elapsed time at all: a paused meeting keeps whatever value the recorder
    // reports, because canonical time includes pauses (docs/recording.md §3).
    const paused = reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'started',
      recordingId: 'rec-1',
    });
    const state = reduceFlow(paused, { type: 'recorder_state', state: 'paused' });
    expect(state).not.toHaveProperty('elapsedMs');
    expect(JSON.stringify(state)).not.toContain('canonicalElapsedMs');
  });

  it('never resumes a session that is not paused', () => {
    const idle = booted();
    expect(reduceFlow(idle, { type: 'recorder_state', state: 'recording' }).phase).toBe('idle');
  });
});

describe('recording → stop', () => {
  const recording = () =>
    reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'started',
      recordingId: 'rec-1',
    });

  it('stops exactly once: a second stop request is dropped', () => {
    const live = recording();
    expect(canStop(live)).toBe(true);
    const stopping = reduceFlow(live, { type: 'stop_requested' });
    expect(stopping.phase).toBe('stopping');
    expect(stopping.busy).toBe(true);
    const second = reduceFlow(stopping, { type: 'stop_requested' });
    expect(second).toBe(stopping);
  });

  it('cannot stop from idle, ready, or processing', () => {
    expect(canStop(booted())).toBe(false);
    expect(canStop(reduceFlow(booted(), { type: 'reset' }))).toBe(false);
  });

  it('moves to uploading with the meeting it was linked to', () => {
    const stopped = reduceFlow(reduceFlow(recording(), { type: 'stop_requested' }), {
      type: 'stopped',
      meeting: { meetingId: 'm-1', workspaceId: 'ws-1', title: 'Suhbat — 8 Oct, 14:32' },
    });
    expect(stopped.phase).toBe('uploading');
    expect(stopped.meeting?.meetingId).toBe('m-1');
    expect(stopped.busy).toBe(false);
  });

  it('keeps the meeting on this device when the network is gone at stop', () => {
    const saved = reduceFlow(reduceFlow(recording(), { type: 'stop_requested' }), {
      type: 'offline_after_stop',
      meeting: null,
    });
    expect(saved.phase).toBe('saved_locally');
    expect(saved.meeting).toBeNull();
  });

  it('ignores a stop result that arrives when nothing was stopping', () => {
    const idle = booted();
    expect(reduceFlow(idle, { type: 'stopped', meeting: null })).toBe(idle);
  });
});

describe('upload → processing → ready', () => {
  const uploading = () =>
    reduceFlow(
      reduceFlow(
        reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
          type: 'started',
          recordingId: 'rec-1',
        }),
        { type: 'stop_requested' },
      ),
      { type: 'stopped', meeting: { meetingId: 'm-1', workspaceId: 'ws-1', title: 't' } },
    );

  it('reports verified chunk counts without inventing a percentage', () => {
    const state = reduceFlow(uploading(), {
      type: 'upload_progress',
      verified: 3,
      total: 12,
      failed: 0,
    });
    expect(state.upload).toEqual({ verified: 3, total: 12, failed: 0 });
    expect(JSON.stringify(state)).not.toMatch(/"percent|"progress":\s*0\.\d/);
  });

  it('falls back to saved-locally when the pump cannot reach the server, and recovers', () => {
    const offline = reduceFlow(uploading(), {
      type: 'upload_offline',
      progress: { verified: 2, total: 12, failed: 1 },
    });
    expect(offline.phase).toBe('saved_locally');
    const back = reduceFlow(offline, {
      type: 'upload_progress',
      verified: 5,
      total: 12,
      failed: 0,
    });
    expect(back.phase).toBe('uploading');
  });

  it('reaches ready only when the canonical product state says ready', () => {
    const processing = reduceFlow(uploading(), { type: 'upload_complete' });
    expect(processing.phase).toBe('processing');

    const stillWorking = reduceFlow(processing, {
      type: 'processing',
      productState: 'transcribing',
      steps: [{ key: 'capture', label: 'Captured', state: 'done' }],
      error: null,
      durationMs: null,
      languages: [],
    });
    expect(stillWorking.phase).toBe('processing');

    const done = reduceFlow(stillWorking, {
      type: 'processing',
      productState: 'ready',
      steps: [{ key: 'capture', label: 'Captured', state: 'done' }],
      error: null,
      durationMs: 1_862_000,
      languages: ['uz', 'ru'],
    });
    expect(done.phase).toBe('ready');
    expect(done.processing?.durationMs).toBe(1_862_000);
    expect(done.processing?.languages).toEqual(['uz', 'ru']);
  });

  it('surfaces a transcription failure as "saved, analysis pending" rather than an error dead-end', () => {
    const failed = reduceFlow(uploading(), {
      type: 'processing',
      productState: 'transcription_failed',
      steps: [{ key: 'capture', label: 'Captured', state: 'done' }],
      error: { tone: 'warn', title: copy.errors.pipelineFailed },
      durationMs: null,
      languages: [],
    });
    expect(failed.phase).toBe('analysis_failed');
    expect(failed.notice?.title).toBe(copy.errors.pipelineFailed);
  });

  it('carries detected languages only when the provider reported them', () => {
    const noLanguages = reduceFlow(uploading(), {
      type: 'processing',
      productState: 'ready',
      steps: [],
      error: null,
      durationMs: 60_000,
      languages: [],
    });
    expect(noLanguages.processing?.languages).toEqual([]);
  });
});

describe('guards', () => {
  it('refuses a workspace switch while a meeting is in flight', () => {
    const recording = reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'started',
      recordingId: 'rec-1',
    });
    const switched = reduceFlow(recording, { type: 'workspace_selected', workspaceId: 'ws-2' });
    expect(switched.workspaceId).toBe('ws-1');
    const idleSwitch = reduceFlow(booted(), { type: 'workspace_selected', workspaceId: 'ws-2' });
    expect(idleSwitch.workspaceId).toBe('ws-2');
  });

  it('asks before closing only while capture is live', () => {
    const recording = reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'started',
      recordingId: 'rec-1',
    });
    expect(reduceFlow(recording, { type: 'close_requested' }).closeRequested).toBe(true);
    expect(reduceFlow(booted(), { type: 'close_requested' }).closeRequested).toBe(false);
    expect(reduceFlow(recording, { type: 'close_cancelled' }).closeRequested).toBe(false);
  });

  it('clears the close request once the session has been stopped and saved', () => {
    const closing = reduceFlow(
      reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
        type: 'started',
        recordingId: 'rec-1',
      }),
      { type: 'close_requested' },
    );
    const stopped = reduceFlow(reduceFlow(closing, { type: 'stop_requested' }), {
      type: 'stopped',
      meeting: { meetingId: 'm-1', workspaceId: 'ws-1', title: 't' },
    });
    expect(stopped.closeRequested).toBe(false);
  });

  it('treats starting, recording, paused and stopping as "capturing"', () => {
    expect(isCapturing(reduceFlow(booted(), { type: 'start_requested' }))).toBe(true);
    expect(isCapturing(booted())).toBe(false);
  });

  it('resets to idle without losing the workspace choice', () => {
    const ready = reduceFlow(booted(), {
      type: 'ready',
      meeting: { meetingId: 'm-1', workspaceId: 'ws-1', title: 't' },
    });
    const reset = reduceFlow(ready, { type: 'reset' });
    expect(reset.phase).toBe('idle');
    expect(reset.workspaceId).toBe('ws-1');
    expect(reset.meeting).toBeNull();
    expect(reset.upload).toBeNull();
  });
});

describe('processing headlines', () => {
  it('maps every canonical product state onto one of four honest sentences', () => {
    const sentences = [
      'recording',
      'uploading',
      'preparing',
      'transcribing',
      'normalizing_transcript',
      'analyzing',
      'normalizing_analysis',
      'indexing',
      'something_unheard_of',
    ].map((state) => processingHeadline(state, copy.after).title);
    for (const sentence of sentences) {
      expect(Object.values(copy.after)).toContain(sentence);
    }
    // Never a percentage, never a fabricated fraction.
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/%|\d+\s*\/\s*\d+/);
    }
  });
});

describe('workspace behaviour', () => {
  const workspaces: WorkspaceSummaryDto[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Alpha',
      role: 'owner',
      defaultMeetingTypeId: '22222222-2222-4222-8222-222222222222',
      defaultMeetingTypeLabel: 'General',
      meetingTypeCount: 7,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Beta',
      role: 'member',
      defaultMeetingTypeId: null,
      defaultMeetingTypeLabel: null,
      meetingTypeCount: 0,
    },
  ];

  it('selects the only workspace automatically', () => {
    const session = { ...emptySession, workspaces: [workspaces[0]!] };
    expect(resolveWorkspace(session)?.id).toBe(workspaces[0]!.id);
  });

  it('remembers the last chosen workspace across restarts', () => {
    const session = {
      ...emptySession,
      workspaces,
      selectedWorkspaceId: workspaces[1]!.id,
    };
    expect(resolveWorkspace(session)?.id).toBe(workspaces[1]!.id);
  });

  it('asks rather than guessing when several workspaces exist and none was chosen', () => {
    expect(resolveWorkspace({ ...emptySession, workspaces })).toBeNull();
  });

  it('drops a remembered workspace the user no longer belongs to', () => {
    const stale = { ...emptySession, workspaces: [workspaces[0]!], selectedWorkspaceId: 'gone' };
    expect(resolveWorkspace(stale)?.id).toBe(workspaces[0]!.id);
  });
});

describe('automatic meeting title', () => {
  it('matches the "Suhbat — 8 Oct, 14:32" shape in local time', () => {
    const title = temporaryMeetingTitle(new Date(2026, 9, 8, 14, 32));
    expect(title).toBe('Suhbat — 8 Oct, 14:32');
  });

  it('zero-pads the time so a nine-in-the-morning meeting reads 09', () => {
    expect(temporaryMeetingTitle(new Date(2026, 0, 1, 9, 5))).toBe('Suhbat — 1 Jan, 09:05');
  });

  it('stays inside the 2–180 character limit the meeting schema enforces', () => {
    const title = temporaryMeetingTitle(new Date(2026, 10, 28, 23, 59));
    expect(title.length).toBeGreaterThanOrEqual(2);
    expect(title.length).toBeLessThanOrEqual(180);
  });
});

/**
 * Crash recovery: a session found on disk is prepared, then drained through the same queue. The
 * reducer half of that is "idle → uploading with the new meeting attached", which is what this covers;
 * the Rust half (closing an interrupted manifest) is covered by recorder-core's own tests.
 */
describe('crash recovery', () => {
  it('starts uploading a recovered session from idle', () => {
    const state = reduceFlow(booted(), {
      type: 'recovered_upload_started',
      meeting: { meetingId: 'm-recovered', workspaceId: 'ws-1', title: 'Suhbat — 8 Oct, 09:00' },
    });
    expect(state.phase).toBe('uploading');
    expect(state.meeting?.meetingId).toBe('m-recovered');
  });

  it('refuses to start a recovered upload while a meeting is live', () => {
    const recording = reduceFlow(reduceFlow(booted(), { type: 'start_requested' }), {
      type: 'started',
      recordingId: 'rec-1',
    });
    const attempted = reduceFlow(recording, {
      type: 'recovered_upload_started',
      meeting: { meetingId: 'm-2', workspaceId: 'ws-1', title: 't' },
    });
    expect(attempted).toBe(recording);
  });
});
