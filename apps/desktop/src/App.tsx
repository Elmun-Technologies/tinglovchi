/**
 * SUHBAT one-tap recorder.
 *
 * The entire product promise lives in this file's orchestration: press the button, talk, press stop,
 * leave. Everything else — creating the meeting, chunking, uploading, transcription, analysis,
 * indexing — happens because the existing pipeline already does it, not because this UI re-implements
 * any of it.
 *
 * What this component is responsible for:
 * 1. **One button.** Starting a recording creates the meeting context automatically; nothing is asked
 *    of the user first.
 * 2. **Observing, never inventing.** Timers come from the recorder's monotonic clock; the processing
 *    screen shows canonical pipeline steps; `ready` is shown only when the server says the meeting is
 *    ready. There is no percentage anywhere, because nobody knows one.
 * 3. **Never losing audio.** Capture is local-first, an offline stop keeps the recording on disk, the
 *    upload pump retries forever, and no code path in this app deletes a recording.
 * 4. **Refusing to double-fire.** Start, stop, and upload are each guarded by the flow reducer, so a
 *    double click or a 500 ms poll can never produce two recordings or two uploads of one chunk.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BridgeUnavailableError, createBridge, toRecorderError } from './bridge.ts';
import {
  type FlowNotice,
  type MeetingContext,
  initialFlowState,
  isCapturing as isFlowCapturing,
  reduceFlow,
} from './flow.ts';
import {
  type Action,
  controlsFor,
  initialState,
  noticeFromError,
  reduce,
} from './state.ts';
import { createSessionStore, resolveWorkspace, type StoredSession } from './session-store.ts';
import {
  CloudError,
  cloudBaseUrl,
  connectApprovalUrl,
  createCloudClient,
  readBuildEnv,
  type CloudClient,
} from './cloud.ts';
import { createLocalChunkSource, createUploadNetworkAdapter, createUploadRunner } from './upload-runner.ts';
import { DesktopRecordingUploadQueue } from './upload-queue.ts';
import { copy, temporaryMeetingTitle } from './copy.ts';
import { IdleView } from './views/idle-view.tsx';
import { RecordingView } from './views/recording-view.tsx';
import { AnalysisFailedView, ProcessingView } from './views/processing-view.tsx';
import { ReadyView } from './views/ready-view.tsx';
import { SignInView } from './views/signin-view.tsx';
import { ConsentView } from './views/consent-view.tsx';
import { SettingsSheet } from './views/settings-sheet.tsx';
import { CloseGuard } from './views/close-guard.tsx';

const POLL_ACTIVE_MS = 500;
const POLL_IDLE_MS = 2_000;
const POLL_PROCESSING_MS = 3_000;
const UPLOAD_PUMP_MS = 1_500;

export function App() {
  const bridge = useMemo(() => createBridge(), []);
  const sessionStore = useMemo(() => createSessionStore(), []);
  const [flow, dispatch] = useReducer(reduceFlow, initialFlowState);
  const [panel, send] = useReducer(reduce, initialState);
  const [session, setSession] = useState<StoredSession>(() => sessionStore.read());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [authPhase, setAuthPhase] = useState<'idle' | 'waiting'>('idle');
  const [deviceUid, setDeviceUid] = useState<string | null>(null);
  const [captureSystemAudio, setCaptureSystemAudio] = useState(true);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [recoveredSessionId, setRecoveredSessionId] = useState<string | null>(null);

  const sessionRef = useRef(session);
  sessionRef.current = session;

  const apiBase = useMemo(() => cloudBaseUrl(readBuildEnv()), []);
  const cloud: CloudClient | null = useMemo(
    () =>
      apiBase
        ? createCloudClient({
            baseUrl: apiBase,
            tokenProvider: () => sessionRef.current.token,
          })
        : null,
    [apiBase],
  );

  const uploadRunner = useMemo(() => {
    if (!cloud) return null;
    const queue = new DesktopRecordingUploadQueue({
      adapter: createUploadNetworkAdapter(cloud),
      localFiles: createLocalChunkSource((localFile) => {
        if (uploadSessionIdRef.current) {
          return bridge.readSessionChunk(uploadSessionIdRef.current, localFile);
        }
        return bridge.readChunkBytes(localFile);
      }),
    });
    return createUploadRunner({ queue, reader: () => Promise.resolve(new Uint8Array()) });
  }, [bridge, cloud]);

  const uploadSessionIdRef = useRef<string | null>(null);
  const meetingRef = useRef<MeetingContext | null>(null);
  // Read through a function so TypeScript does not narrow the ref to `null` after an assignment:
  // meeting linkage is set asynchronously and must be re-read after every await.
  const currentMeeting = (): MeetingContext | null => meetingRef.current;
  const startedAtRef = useRef<Date | null>(null);
  const uploadingRef = useRef(false);
  const processingRef = useRef(false);

  const persistSession = useCallback(
    (next: StoredSession) => {
      sessionRef.current = next;
      setSession(next);
      sessionStore.write(next);
    },
    [sessionStore],
  );

  const notice = flow.notice ?? panel.notice;

  const fail = useCallback((error: unknown, fallback: FlowNotice) => {
    const recorderError = toRecorderError(error);
    if (error instanceof BridgeUnavailableError) {
      dispatch({ type: 'notice', notice: { tone: 'error', title: 'Recorder is unavailable', detail: error.message } });
      return;
    }
    if (error instanceof CloudError) {
      dispatch({ type: 'notice', notice: cloudNotice(error) });
      return;
    }
    if (recorderError.code === 'internal_error' && error instanceof Error) {
      dispatch({ type: 'notice', notice: fallback });
      return;
    }
    dispatch({ type: 'notice', notice: noticeFromError(recorderError) });
  }, []);

  /* ---------------------------------------------------------------- boot */

  useEffect(() => {
    send({ type: 'bridge', kind: bridge.kind });
  }, [bridge.kind, send]);

  useEffect(() => {
    if (!apiBase) {
      dispatch({
        type: 'notice',
        notice: { tone: 'error', title: copy.errors.notConfigured },
      });
    }
  }, [apiBase]);

  useEffect(() => {
    if (bridge.kind === 'unavailable') return;
    void (async () => {
      await run('permissions', () => bridge.refreshPermissions(), (snapshot) =>
        send({ type: 'permissions', snapshot }),
      );
      await run('recovery', () => bridge.scanSessions(), (report) => {
        send({ type: 'recovery', report });
        const durable = report.sessions.find(
          (candidate) => candidate.recoverable && candidate.durableChunkCount > 0,
        );
        if (durable) setRecoveredSessionId(durable.sessionId);
      });
      await run('devices', () => bridge.listDevices('microphone'), (devices) => {
        send({ type: 'devices', devices });
        const preferred =
          devices.find((device) => device.isAvailable && device.isDefault) ??
          devices.find((device) => device.isAvailable);
        setDeviceUid(preferred?.uid ?? null);
      });
      await run('status', () => bridge.status(), (status) => send({ type: 'status', status }));
    })();
    // Boot once. Everything after this is driven by polling and user intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  /** Restores or refreshes the desktop session, then decides which phase the app opens in. */
  useEffect(() => {
    if (!cloud) {
      dispatch({ type: 'booted', signedIn: false, workspaceId: null, consented: false });
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = sessionStore.read();
      let workspaces = stored.workspaces;
      let selectedWorkspaceId = stored.selectedWorkspaceId;
      let signedIn = Boolean(stored.token);
      let userEmail = stored.userEmail;

      if (stored.token) {
        try {
          const info = await cloud.describeSession();
          if (cancelled) return;
          workspaces = info.workspaces;
          userEmail = info.userEmail;
          selectedWorkspaceId = info.defaultWorkspaceId ?? selectedWorkspaceId;
        } catch (cause) {
          // An expired or revoked session is a normal state, not a crash: drop the local token and
          // ask for sign-in. Nothing else is cleared, so the workspace choice survives.
          if (cause instanceof CloudError && (cause.code === 'unauthorized' || cause.code === 'not_found')) {
            persistSession({ ...stored, token: null, userId: null, userEmail: null });
            signedIn = false;
          } else if (!cancelled) {
            fail(cause, { tone: 'error', title: copy.errors.generic });
          }
        }
      }

      if (cancelled) return;
      persistSession({
        ...stored,
        workspaces,
        selectedWorkspaceId,
        userEmail,
        token: signedIn ? stored.token : null,
      });
      const workspace = selectedWorkspaceId ?? (workspaces.length === 1 ? workspaces[0]!.id : null);
      dispatch({
        type: 'booted',
        signedIn,
        workspaceId: workspace,
        consented: Boolean(stored.consentAcknowledgedAt),
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud]);

  /* ------------------------------------------------------------- polling */

  const capturing = isFlowCapturing(flow) || (panel.status ? isCapturingState(panel.status.state) : false);
  useEffect(() => {
    if (bridge.kind === 'unavailable') return;
    const interval = capturing ? POLL_ACTIVE_MS : POLL_IDLE_MS;
    const timer = window.setInterval(() => {
      void run('status', () => bridge.status(), (status) => send({ type: 'status', status }));
    }, interval);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.kind, capturing]);

  useEffect(() => {
    if (bridge.kind === 'unavailable') return;
    return bridge.subscribe(
      (event) => {
        send({ type: 'event', event });
        if (event.type === 'close_requested') dispatch({ type: 'close_requested' });
      },
      (error) => send({ type: 'error', error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, dispatch]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  /* ------------------------------------------------------ upload pumping */

  useEffect(() => {
    if (!uploadRunner || !cloud) return;
    if (flow.phase !== 'uploading' && flow.phase !== 'saved_locally') return;
    let cancelled = false;

    const pump = async () => {
      if (uploadingRef.current) return;
      uploadingRef.current = true;
      try {
        const manifest = await bridge.manifest();
        if (cancelled || !manifest) return;
        uploadRunner.bind(manifest);
        const outcome = await uploadRunner.tick();
        if (cancelled) return;
        if (outcome.kind === 'finalized') {
          dispatch({ type: 'upload_complete' });
          return;
        }
        if (outcome.kind === 'offline') {
          dispatch({ type: 'upload_offline', progress: outcome.progress });
          return;
        }
        dispatch({
          type: 'upload_progress',
          verified: outcome.progress.verified,
          total: outcome.progress.total,
          failed: outcome.progress.failed,
        });
      } catch (cause) {
        if (!cancelled) fail(cause, { tone: 'warn', title: copy.errors.uploadRetry });
      } finally {
        uploadingRef.current = false;
      }
    };

    void pump();
    const timer = window.setInterval(() => void pump(), UPLOAD_PUMP_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadRunner, cloud, flow.phase]);

  /* --------------------------------------------------- processing polling */

  useEffect(() => {
    if (!cloud || !flow.meeting) return;
    if (flow.phase !== 'processing' && flow.phase !== 'uploading') return;
    const meeting = flow.meeting;
    let cancelled = false;

    const poll = async () => {
      if (processingRef.current) return;
      processingRef.current = true;
      try {
        const state = await cloud.getMeetingProcessing(meeting.meetingId, meeting.workspaceId);
        if (cancelled) return;
        const error = state.timeline.error
          ? {
              tone: 'warn' as const,
              title: copy.errors.pipelineFailed,
              detail: state.timeline.error.hint ?? state.timeline.error.message,
            }
          : null;
        dispatch({
          type: 'processing',
          productState: state.productState,
          steps: state.timeline.steps,
          error,
          durationMs: state.canonicalDurationMs,
          languages: state.detectedLanguages,
        });
        if (state.productState === 'ready') {
          dispatch({ type: 'ready', meeting });
        }
      } catch (cause) {
        if (!cancelled) fail(cause, { tone: 'warn', title: copy.errors.generic });
      } finally {
        processingRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_PROCESSING_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud, flow.phase, flow.meeting?.meetingId]);

  /* ---------------------------------------------------------------- auth */

  const requestCode = useCallback(async () => {
    if (!cloud) return;
    setPairingBusy(true);
    setPairingError(null);
    try {
      const created = await cloud.createConnectCode('SUHBAT desktop');
      dispatch({ type: 'pairing_code', code: created.code });
      setAuthPhase('waiting');
      void bridge.openExternal(connectApprovalUrl(apiBase ?? ''));
    } catch (cause) {
      setPairingError(cause instanceof CloudError ? cause.message : copy.errors.generic);
    } finally {
      setPairingBusy(false);
    }
  }, [apiBase, bridge, cloud]);

  /** Polls until the browser approval lands, then trades the code for a session. */
  useEffect(() => {
    if (authPhase !== 'waiting' || !cloud || !flow.pairingCode) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const status = await cloud.connectCodeStatus(flow.pairingCode!);
        if (cancelled || status.status !== 'authorized') return;
        const created = await cloud.exchangeConnectCode(flow.pairingCode!, 'SUHBAT desktop');
        if (cancelled) return;
        const next: StoredSession = {
          token: created.token,
          userId: created.userId,
          userEmail: created.userEmail,
          workspaces: created.workspaces,
          selectedWorkspaceId: created.defaultWorkspaceId,
          consentAcknowledgedAt: null,
          sessionExpiresAt: created.expiresAt,
        };
        persistSession(next);
        setAuthPhase('idle');
        dispatch({
          type: 'signed_in',
          workspaceId:
            created.defaultWorkspaceId ??
            (created.workspaces.length === 1 ? created.workspaces[0]!.id : null),
        });
        dispatch({ type: 'pairing_code', code: null });
      } catch (cause) {
        if (!cancelled) setPairingError(cause instanceof CloudError ? cause.message : copy.errors.generic);
      }
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authPhase, cloud, flow.pairingCode]);

  /* -------------------------------------------------------------- actions */

  const workspace = resolveWorkspace(session);
  const controls = controlsFor(panel);
  const micDenied = panel.permissions?.microphone === 'permission_denied';
  const systemAudioSupported = panel.permissions
    ? panel.permissions.systemAudio !== 'device_unavailable'
    : true;

  /** Creates the meeting the recording will attach to. Offline is an allowed outcome, not a failure. */
  const ensureMeeting = useCallback(async (): Promise<MeetingContext | null> => {
    if (!cloud) return null;
    const existing = currentMeeting();
    if (existing) return existing;
    const workspaceId = sessionRef.current.selectedWorkspaceId ?? resolveWorkspace(sessionRef.current)?.id ?? null;
    if (!workspaceId) return null;
    const startedAt = startedAtRef.current ?? new Date();
    const created = await cloud.createMeeting({
      workspaceId,
      title: temporaryMeetingTitle(startedAt),
      source: 'desktop_recorder',
      startedAt: startedAt.toISOString(),
    });
    const meeting: MeetingContext = {
      meetingId: created.meeting.id,
      workspaceId: created.meeting.workspaceId,
      title: created.meeting.title,
    };
    meetingRef.current = meeting;
    try {
      await bridge.linkMeeting(meeting.workspaceId, meeting.meetingId);
    } catch {
      // Linkage is metadata. If the recorder refuses it, the upload path still carries the meeting in
      // the flow state, so a failed link is logged and never blocks the recording.
    }
    return meeting;
  }, [bridge, cloud]);

  const start = useCallback(async () => {
    if (!canStartNow(flow)) return;
    dispatch({ type: 'start_requested' });
    startedAtRef.current = new Date();
    meetingRef.current = null;
    try {
      // Meeting creation is best-effort on purpose: a recording must start even with no network.
      try {
        await ensureMeeting();
      } catch {
        /* offline or unauthorized — handled after stop */
      }
      const linked = currentMeeting();
      const status = await bridge.start({
        workspaceId: linked?.workspaceId ?? workspace?.id ?? undefined,
        meetingId: linked?.meetingId ?? undefined,
        microphoneDeviceUid: deviceUid,
        captureSystemAudio: captureSystemAudio && systemAudioSupported,
        consentAcknowledged: true,
        chunkIntervalMs: 30_000,
      });
      send({ type: 'status', status });
      dispatch({ type: 'started', recordingId: status.recordingId });
    } catch (cause) {
      dispatch({ type: 'start_failed', notice: startFailureNotice(cause) });
    }
  }, [bridge, captureSystemAudio, deviceUid, ensureMeeting, flow, systemAudioSupported, workspace?.id]);

  const stop = useCallback(async () => {
    dispatch({ type: 'stop_requested' });
    try {
      const status = await bridge.stop();
      send({ type: 'status', status });
      const manifest = await bridge.manifest();
      send({ type: 'manifest', manifest });
      try {
        if (!currentMeeting()) await ensureMeeting();
      } catch {
        /* stays local until the network returns */
      }
      const linked = currentMeeting();
      if (!linked) {
        dispatch({ type: 'offline_after_stop', meeting: null });
        return;
      }
      dispatch({ type: 'stopped', meeting: linked });
    } catch (cause) {
      dispatch({ type: 'busy', busy: false });
      fail(cause, { tone: 'error', title: copy.errors.generic });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, ensureMeeting]);

  const stopAndClose = useCallback(async () => {
    await stop();
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    await bridge.finishClose();
  }, [bridge, stop]);

  const openResult = useCallback(() => {
    if (!apiBase || !flow.meeting) return;
    void bridge.openExternal(
      `${apiBase}/w/${flow.meeting.workspaceId}/meetings/${flow.meeting.meetingId}`,
    );
  }, [apiBase, bridge, flow.meeting]);

  const signOut = useCallback(async () => {
    if (cloud) {
      try {
        await cloud.revokeSession();
      } catch {
        // Revoking is best-effort: clearing the local token is what actually locks this device.
      }
    }
    persistSession({ ...sessionRef.current, token: null, userId: null, userEmail: null, consentAcknowledgedAt: null });
    meetingRef.current = null;
    setSettingsOpen(false);
    dispatch({ type: 'signed_out' });
  }, [cloud, persistSession]);

  const acceptConsent = useCallback(() => {
    const next: StoredSession = {
      ...sessionRef.current,
      consentAcknowledgedAt: new Date().toISOString(),
    };
    persistSession(next);
    dispatch({
      type: 'consent_acknowledged',
      workspaceId:
        next.selectedWorkspaceId ?? (next.workspaces.length === 1 ? next.workspaces[0]!.id : null),
    });
  }, [persistSession]);

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      const next: StoredSession = { ...sessionRef.current, selectedWorkspaceId: workspaceId };
      persistSession(next);
      dispatch({ type: 'workspace_selected', workspaceId });
      if (cloud && sessionRef.current.token) {
        void cloud.rememberWorkspace(workspaceId).catch(() => undefined);
      }
      setSettingsOpen(false);
    },
    [cloud, persistSession],
  );

  /**
   * Refreshes the workspace list when the user opens settings.
   *
   * The stored list can go stale (a workspace was added or a membership revoked in the web app), and
   * `describeSession` already ran at boot. Reading membership straight from the server on demand means
   * the switcher can only ever offer workspaces this account is really a member of.
   */
  useEffect(() => {
    if (!settingsOpen || !cloud || !sessionRef.current.token) return;
    let cancelled = false;
    void (async () => {
      try {
        const workspaces = await cloud.listWorkspaces();
        if (cancelled) return;
        const stored = sessionRef.current;
        const stillMember = workspaces.some((w) => w.id === stored.selectedWorkspaceId);
        const next: StoredSession = {
          ...stored,
          workspaces,
          selectedWorkspaceId: stillMember ? stored.selectedWorkspaceId : null,
        };
        persistSession(next);
        const resolved =
          next.selectedWorkspaceId ?? (workspaces.length === 1 ? workspaces[0]!.id : null);
        if (resolved) dispatch({ type: 'workspace_selected', workspaceId: resolved });
      } catch {
        // A transient failure keeps the last known list; the switcher is never blocked by it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, cloud, persistSession]);

  /** Uploads a crash-recovered session: closes its manifest, then drains it through the same queue. */
  const uploadRecovered = useCallback(async () => {
    if (!uploadRunner || !cloud || !recoveredSessionId) return;
    const summary = panel.recovery?.sessions.find((s) => s.sessionId === recoveredSessionId);
    if (!summary) return;
    try {
      const workspaceId = sessionRef.current.selectedWorkspaceId ?? workspace?.id ?? null;
      if (!workspaceId) return;
      const created = await cloud.createMeeting({
        workspaceId,
        title: temporaryMeetingTitle(new Date(summary.startedAt)),
        source: 'desktop_recorder',
        startedAt: summary.startedAt,
      });
      const meeting: MeetingContext = {
        meetingId: created.meeting.id,
        workspaceId: created.meeting.workspaceId,
        title: created.meeting.title,
      };
      meetingRef.current = meeting;
      uploadSessionIdRef.current = recoveredSessionId;
      const manifest = await bridge.prepareRecoveredUpload(
        recoveredSessionId,
        meeting.workspaceId,
        meeting.meetingId,
      );
      send({ type: 'manifest', manifest });
      dispatch({ type: 'recovered_upload_started', meeting });
      setRecoveredSessionId(null);
    } catch (cause) {
      uploadSessionIdRef.current = null;
      fail(cause, { tone: 'warn', title: copy.errors.uploadRetry });
    }
  }, [bridge, cloud, panel.recovery, recoveredSessionId, uploadRunner, workspace?.id]);

  /* --------------------------------------------------------------- render */

  const deviceLabel = deviceSummary(panel.permissions, panel.status?.sources.length ?? 0);
  const settingDevices = panel.devices;

  return (
    <div className="app" data-phase={flow.phase}>
      {notice ? (
        <div className={`notice ${notice.tone}`} role="status">
          <div>
            <strong>{notice.title}</strong>
            {notice.detail ? <p>{notice.detail}</p> : null}
          </div>
          <button onClick={() => dispatch({ type: 'notice', notice: null })} aria-label="Yopish">
            ×
          </button>
        </div>
      ) : null}

      {recoveredSessionId && flow.phase === 'idle' ? (
        <div className="notice warn recovery" role="status">
          <div>
            <strong>{copy.recovery.title}</strong>
            <p>{copy.recovery.body}</p>
          </div>
          <div className="notice-actions">
            <button className="pill-button primary" onClick={() => void uploadRecovered()}>
              {copy.recovery.upload}
            </button>
            <button onClick={() => setRecoveredSessionId(null)}>{copy.recovery.discardLater}</button>
          </div>
        </div>
      ) : null}

      {micDenied && flow.phase === 'idle' ? (
        <div className="notice error" role="alert">
          <div>
            <strong>{copy.errors.microphoneDenied}</strong>
            <p>{copy.errors.microphoneDeniedDetail}</p>
          </div>
          <button
            className="pill-button"
            onClick={() => void run('settings', () => bridge.openSettings('microphone'))}
          >
            Sozlamalar
          </button>
        </div>
      ) : null}

      {flow.phase === 'booting' ? <BootingView /> : null}

      {flow.phase === 'signed_out' ? (
        <SignInView
          phase={authPhase}
          code={flow.pairingCode}
          error={pairingError}
          busy={pairingBusy}
          canOpenBrowser={bridge.kind !== 'unavailable' && Boolean(apiBase)}
          onRequestCode={() => void requestCode()}
          onOpenBrowser={() => void bridge.openExternal(connectApprovalUrl(apiBase ?? ''))}
          onCancel={() => {
            setAuthPhase('idle');
            setPairingError(null);
            dispatch({ type: 'pairing_code', code: null });
          }}
        />
      ) : null}

      {flow.phase === 'consent' ? <ConsentView onAccept={acceptConsent} /> : null}

      {flow.phase === 'idle' ? (
        <IdleView
          workspace={workspace}
          workspaceCount={session.workspaces.length}
          deviceReady={Boolean(panel.permissions?.microphone === 'permission_granted') && !controls.blockedReason}
          deviceLabel={deviceLabel}
          canStart={
            Boolean(apiBase) &&
            bridge.kind !== 'unavailable' &&
            Boolean(workspace) &&
            !micDenied &&
            !controls.blockedReason
          }
          starting={false}
          onStart={() => void start()}
          onOpenSettings={() => setSettingsOpen(true)}
          onSwitchWorkspace={() => setSettingsOpen(true)}
        />
      ) : null}

      {flow.phase === 'recording' || flow.phase === 'paused' || flow.phase === 'starting' || flow.phase === 'stopping' ? (
        <RecordingView
          status={panel.status}
          paused={flow.phase === 'paused'}
          canPause={flow.phase === 'recording'}
          canResume={flow.phase === 'paused'}
          canStop={flow.phase === 'recording' || flow.phase === 'paused'}
          stopping={flow.phase === 'stopping'}
          onPause={() => void run('pause', () => bridge.pause(), (status) => send({ type: 'status', status }))}
          onResume={() => void run('resume', () => bridge.resume(), (status) => send({ type: 'status', status }))}
          onStop={() => void stop()}
        />
      ) : null}

      {flow.phase === 'uploading' || flow.phase === 'saved_locally' || flow.phase === 'processing' ? (
        <ProcessingView
          phase={flow.phase}
          productState={flow.processing?.productState ?? null}
          steps={flow.processing?.steps ?? []}
          progress={flow.upload}
          offline={!online || flow.phase === 'saved_locally'}
          onOpenResult={openResult}
        />
      ) : null}

      {flow.phase === 'analysis_failed' ? (
        <AnalysisFailedView
          notice={flow.processing?.error?.title ?? copy.errors.pipelineFailed}
          onOpenResult={openResult}
          onNewMeeting={() => {
            meetingRef.current = null;
            uploadSessionIdRef.current = null;
            dispatch({ type: 'reset' });
          }}
        />
      ) : null}

      {flow.phase === 'ready' ? (
        <ReadyView
          title={flow.meeting?.title ?? copy.tagline}
          durationMs={flow.processing?.durationMs ?? null}
          languages={flow.processing?.languages ?? []}
          onOpenResult={openResult}
          onNewMeeting={() => {
            meetingRef.current = null;
            uploadSessionIdRef.current = null;
            dispatch({ type: 'reset' });
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsSheet
          workspaces={session.workspaces}
          selectedWorkspaceId={session.selectedWorkspaceId}
          devices={settingDevices}
          selectedDeviceUid={deviceUid}
          captureSystemAudio={captureSystemAudio}
          systemAudioSupported={systemAudioSupported}
          userEmail={session.userEmail}
          onSelectWorkspace={selectWorkspace}
          onSelectDevice={setDeviceUid}
          onToggleSystemAudio={setCaptureSystemAudio}
          onSignOut={() => void signOut()}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {flow.closeRequested ? (
        <CloseGuard
          busy={flow.phase === 'stopping'}
          onStopAndSave={() => void stopAndClose()}
          onCancel={() => dispatch({ type: 'close_cancelled' })}
        />
      ) : null}
    </div>
  );

  /** Wraps a bridge call so a failure becomes a visible notice instead of a silent rejection. */
  function run<T>(
    label: string,
    work: () => Promise<T>,
    onResult?: (value: T) => void,
  ): Promise<void> {
    return Promise.resolve()
      .then(work)
      .then((value) => {
        onResult?.(value);
      })
      .catch((error: unknown) => {
        fail(error, { tone: 'error', title: copy.errors.generic, detail: `${label} failed` });
      });
  }
}

function BootingView() {
  return (
    <section className="stage stage-booting">
      <div className="stage-centre">
        <span className="wordmark">SUHBAT</span>
        <div className="spinner" aria-hidden="true" />
      </div>
    </section>
  );
}

function canStartNow(flow: { phase: string; busy: boolean; workspaceId: string | null }): boolean {
  return flow.phase === 'idle' && !flow.busy && flow.workspaceId !== null;
}

function isCapturingState(state: string): boolean {
  return state === 'recording' || state === 'paused' || state === 'finalizing';
}

function deviceSummary(
  permissions: { microphone: string; systemAudio: string } | null,
  sourceCount: number,
): string {
  if (!permissions) return copy.idle.deviceChecking;
  if (permissions.microphone === 'permission_denied') return copy.errors.microphoneDenied;
  if (permissions.microphone !== 'permission_granted') return copy.idle.deviceChecking;
  if (permissions.systemAudio === 'device_unavailable' || sourceCount < 2) {
    return copy.errors.systemAudioUnavailable;
  }
  return copy.idle.deviceReady;
}

function startFailureNotice(cause: unknown): FlowNotice {
  const error = toRecorderError(cause);
  switch (error.code) {
    case 'permission_denied':
      return { tone: 'error', title: copy.errors.microphoneDenied, detail: copy.errors.microphoneDeniedDetail };
    case 'system_audio_unavailable':
      return {
        tone: 'warn',
        title: copy.errors.systemAudioUnavailable,
        detail: copy.errors.systemAudioUnavailableDetail,
      };
    case 'disk_space_insufficient':
    case 'disk_full':
      return { tone: 'error', title: copy.errors.diskFull, detail: error.message };
    case 'device_unavailable':
    case 'device_lost':
      return { tone: 'error', title: copy.errors.deviceLost, detail: error.message };
    default:
      return noticeFromError(error);
  }
}

function cloudNotice(error: CloudError): FlowNotice {
  switch (error.code) {
    case 'offline':
      return { tone: 'warn', title: copy.errors.offline };
    case 'timeout':
      return { tone: 'warn', title: copy.errors.uploadRetry };
    case 'unauthorized':
      return { tone: 'error', title: copy.errors.sessionExpired };
    case 'not_configured':
      return { tone: 'error', title: copy.errors.notConfigured };
    default:
      return { tone: 'warn', title: copy.errors.pipelineFailed, detail: error.message };
  }
}

export default App;
