/**
 * The whole recorder UI.
 *
 * Layout follows the two things an operator actually needs while a meeting runs: (1) is it still
 * recording, and for how long, on the canonical meeting clock; (2) are *both* sources healthy. Everything
 * else — markers, notes, chunks, recovery — is visible but secondary.
 *
 * Rules encoded here: no control is enabled that the state machine would reject; a persistence fault
 * disables annotation and stop-flushing controls and shows the fault instead of a green dot; the level
 * meter for an absent source renders "no audio" rather than a fake zero; and no elapsed time is
 * accumulated in JavaScript.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BridgeUnavailableError, createBridge, toRecorderError } from './bridge.ts';
import {
  type Action,
  controlsFor,
  durationSummary,
  formatBytes,
  formatClock,
  initialState,
  meterPercent,
  reduce,
  sourceRows,
} from './state.ts';

const POLL_ACTIVE_MS = 500;
const POLL_IDLE_MS = 2_000;
const CONSENT_TEXT =
  "SUHBAT records the microphone and this Mac's system audio into files on this computer only. Nothing is uploaded, transcribed, or analysed in this version. You are responsible for telling participants that the meeting is being recorded.";

export function App() {
  const bridge = useMemo(() => createBridge(), []);
  const [state, dispatch] = useReducer(reduce, initialState);
  const [note, setNote] = useState('');
  const [consented, setConsented] = useState(false);
  const [deviceUid, setDeviceUid] = useState<string | null>(null);
  const [captureSystemAudio, setCaptureSystemAudio] = useState(true);
  const [chunkIntervalSeconds, setChunkIntervalSeconds] = useState(30);
  const send = useCallback((action: Action) => dispatch(action), []);

  const run = useCallback(
    async <T,>(
      label: string,
      work: () => Promise<T>,
      onResult?: (value: T) => void,
    ): Promise<void> => {
      send({ type: 'busy', busy: true });
      try {
        const value = await work();
        onResult?.(value);
      } catch (error) {
        if (error instanceof BridgeUnavailableError) {
          send({ type: 'bridge', kind: 'unavailable' });
        } else {
          send({ type: 'error', error: toRecorderError(error) });
        }
        console.error(`[recorder] ${label} failed`, error);
      } finally {
        send({ type: 'busy', busy: false });
      }
    },
    [send],
  );

  const refreshStatus = useCallback(
    () => run('status', bridge.status, (status) => send({ type: 'status', status })),
    [bridge, run, send],
  );
  const refreshManifest = useCallback(
    () => run('manifest', bridge.manifest, (manifest) => send({ type: 'manifest', manifest })),
    [bridge, run, send],
  );

  useEffect(() => {
    send({ type: 'bridge', kind: bridge.kind });
  }, [bridge.kind, send]);

  // Startup sequence: permissions, existing sessions to recover, then the current status.
  useEffect(() => {
    if (bridge.kind === 'unavailable') return;
    void run('refresh permissions', bridge.refreshPermissions, (snapshot) =>
      send({ type: 'permissions', snapshot }),
    );
    void run('recovery scan', bridge.scanSessions, (report) => send({ type: 'recovery', report }));
    void run(
      'devices',
      () => bridge.listDevices('microphone'),
      (devices) => {
        send({ type: 'devices', devices });
        const preferred =
          devices.find((device) => device.isAvailable && device.isDefault) ??
          devices.find((device) => device.isAvailable);
        setDeviceUid(preferred?.uid ?? null);
      },
    );
    void refreshStatus();
  }, [bridge, refreshStatus, run, send]);

  // Status polling: the Rust command also pumps the coordinator, so manifest progress survives a missed event.
  const capturing = state.status ? isCapturingState(state.status.state) : false;
  const interval = capturing ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  useEffect(() => {
    if (bridge.kind === 'unavailable') return;
    const timer = window.setInterval(() => void refreshStatus(), interval);
    return () => window.clearInterval(timer);
  }, [bridge.kind, interval, refreshStatus]);

  useEffect(() => {
    if (bridge.kind === 'unavailable') return;
    return bridge.subscribe(
      (event) => {
        send({ type: 'event', event });
        if (event.type === 'chunk_finalized' || event.type === 'annotation') void refreshManifest();
      },
      (error) => send({ type: 'error', error }),
    );
  }, [bridge, refreshManifest, send]);

  const controls = controlsFor(state);
  const summary = durationSummary(state.status);
  const rows = sourceRows(state.status, state.manifest);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-state={state.status?.state ?? 'idle'} />
          <h1>SUHBAT Recorder</h1>
          <span className="state" data-state={state.status?.state ?? 'idle'}>
            {state.status?.state ?? 'idle'}
          </span>
        </div>
        <div className="clocks">
          <div>
            <span className="label">Meeting time</span>
            <strong className="canonical">{summary?.canonical ?? '00:00'}</strong>
          </div>
          <div>
            <span className="label">Captured</span>
            <strong className="active">{summary?.active ?? '00:00'}</strong>
          </div>
          <div>
            <span className="label">Gaps</span>
            <strong className="delta">{summary?.deltaLabel ?? 'no gaps yet'}</strong>
          </div>
          {state.status?.disk ? (
            <div>
              <span className="label">Disk free</span>
              <strong data-ok={state.status.disk.sufficient}>
                {formatBytes(state.status.disk.availableBytes)}
              </strong>
            </div>
          ) : null}
        </div>
      </header>

      {state.notice ? (
        <div ref={noticeRef} className={`notice ${state.notice.tone}`} role="status">
          <div>
            <strong>{state.notice.title}</strong>
            {state.notice.detail ? <p>{state.notice.detail}</p> : null}
          </div>
          <button onClick={() => send({ type: 'notice', notice: null })} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}

      <main>
        <section className="panel">
          <h2>Capture</h2>
          <div className="row">
            <label className="consent">
              <input
                type="checkbox"
                checked={consented}
                onChange={(event) => setConsented(event.target.checked)}
              />
              <span>{CONSENT_TEXT}</span>
            </label>
          </div>
          <div className="row grid">
            <label>
              Microphone device
              <select
                value={deviceUid ?? ''}
                disabled={capturing}
                onChange={(event) => setDeviceUid(event.target.value || null)}
              >
                {state.devices.length === 0 ? <option value="">no device enumerated</option> : null}
                {state.devices.map((device) => (
                  <option key={device.uid} value={device.uid} disabled={!device.isAvailable}>
                    {device.name}
                    {device.isDefault ? ' (default)' : ''}
                    {device.isAvailable ? '' : ' — unavailable'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Chunk length (seconds)
              <input
                type="number"
                min={5}
                max={600}
                step={5}
                disabled={capturing}
                value={chunkIntervalSeconds}
                onChange={(event) => setChunkIntervalSeconds(Number(event.target.value))}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                disabled={capturing}
                checked={captureSystemAudio}
                onChange={(event) => setCaptureSystemAudio(event.target.checked)}
              />
              <span>Record system audio too</span>
            </label>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={state.busy || !controls.canStart || !consented}
              onClick={() =>
                void run('start', () =>
                  bridge.start({
                    microphoneDeviceUid: deviceUid,
                    captureSystemAudio,
                    consentAcknowledged: true,
                    chunkIntervalMs: chunkIntervalSeconds * 1000,
                  }),
                ).then(refreshStatus)
              }
            >
              Start
            </button>
            <button
              disabled={state.busy || !controls.canPause}
              onClick={() => void run('pause', bridge.pause).then(refreshStatus)}
            >
              Pause
            </button>
            <button
              disabled={state.busy || !controls.canResume}
              onClick={() => void run('resume', bridge.resume).then(refreshStatus)}
            >
              Resume
            </button>
            <button
              className="stop"
              disabled={state.busy || !controls.canStop}
              onClick={() =>
                void run('stop', bridge.stop).then(refreshStatus).then(refreshManifest)
              }
            >
              Stop &amp; finalize
            </button>
            <button
              onClick={() =>
                void run('re-check permissions', bridge.refreshPermissions, (snapshot) =>
                  send({ type: 'permissions', snapshot }),
                )
              }
            >
              Re-check permissions
            </button>
          </div>
          {controls.blockedReason ? <p className="hint">{controls.blockedReason}</p> : null}
          {!consented && !controls.blockedReason ? (
            <p className="hint">Confirm the notice above to enable Start.</p>
          ) : null}
        </section>

        <section className="panel">
          <h2>Sources</h2>
          <div className="sources">
            {rows.map((row) => (
              <article key={row.kind} className="source" data-health={row.health}>
                <header>
                  <h3>{row.label}</h3>
                  <span data-health={row.health}>{row.health}</span>
                </header>
                <div className="meter" aria-label={`${row.label} level`}>
                  <div className="meter-fill" style={{ width: `${meterPercent(row.level)}%` }} />
                  {!row.level?.live ? <span className="meter-empty">no audio</span> : null}
                </div>
                <dl>
                  <div>
                    <dt>Device</dt>
                    <dd>{row.device}</dd>
                  </div>
                  <div>
                    <dt>Captured</dt>
                    <dd>{formatClock(row.capturedSeconds * 1000)}</dd>
                  </div>
                  <div>
                    <dt>Dropped samples</dt>
                    <dd data-warn={row.droppedSamples > 0}>{row.droppedSamples}</dd>
                  </div>
                  <div>
                    <dt>Finalized chunks</dt>
                    <dd>{row.chunks}</dd>
                  </div>
                  <div>
                    <dt>Segments</dt>
                    <dd>{row.segmentCount}</dd>
                  </div>
                </dl>
                {row.health === 'unavailable' ? (
                  <button
                    onClick={() => void run('open settings', () => bridge.openSettings(row.kind))}
                  >
                    Open System Settings
                  </button>
                ) : null}
              </article>
            ))}
          </div>
          {state.permissions ? (
            <p className="permissions">
              microphone:{' '}
              <strong data-state={state.permissions.microphone}>
                {state.permissions.microphone}
              </strong>{' '}
              · system audio:{' '}
              <strong data-state={state.permissions.systemAudio}>
                {state.permissions.systemAudio}
              </strong>{' '}
              · backend: <strong>{state.permissions.availability}</strong> · macOS{' '}
              {state.permissions.osVersion}
            </p>
          ) : null}
        </section>

        <section className="panel">
          <h2>Markers &amp; notes</h2>
          <div className="row">
            <button
              className="mark"
              disabled={state.busy || !controls.canAnnotate}
              onClick={() =>
                void run('mark important', () => bridge.markImportant(null)).then(refreshManifest)
              }
            >
              Mark important
            </button>
            <input
              placeholder="Timestamped note (not a transcript)"
              value={note}
              maxLength={4000}
              disabled={state.busy || !controls.canAnnotate}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && note.trim() && controls.canAnnotate) {
                  void run('add note', () => bridge.addNote(note)).then(() => {
                    setNote('');
                    return refreshManifest();
                  });
                }
              }}
            />
            <button
              disabled={state.busy || !controls.canAnnotate || note.trim().length === 0}
              onClick={() =>
                void run('add note', () => bridge.addNote(note)).then(() => {
                  setNote('');
                  return refreshManifest();
                })
              }
            >
              Add note
            </button>
          </div>
          <ul className="annotations">
            {(state.manifest?.markers ?? []).map((marker) => (
              <li key={marker.markerId} className="marker">
                <time>{formatClock(marker.meetingMs)}</time> ★ {marker.label}
              </li>
            ))}
            {(state.manifest?.notes ?? []).map((item) => (
              <li key={item.noteId}>
                <time>{formatClock(item.meetingMs)}</time> {item.text}
              </li>
            ))}
            {!state.manifest ||
            (state.manifest.markers.length === 0 && state.manifest.notes.length === 0) ? (
              <li className="empty">Nothing annotated yet.</li>
            ) : null}
          </ul>
        </section>

        <section className="panel">
          <h2>Local chunks</h2>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Seq</th>
                <th>Meeting</th>
                <th>Samples</th>
                <th>Bytes</th>
                <th>State</th>
                <th>sha256</th>
              </tr>
            </thead>
            <tbody>
              {(state.manifest?.chunks ?? []).map((chunk) => (
                <tr key={chunk.chunkId}>
                  <td>{chunk.sourceKind}</td>
                  <td>{chunk.sequenceNo}</td>
                  <td>
                    {formatClock(chunk.meetingStartMs)} → {formatClock(chunk.meetingEndMs)}
                  </td>
                  <td>{chunk.sampleCount}</td>
                  <td>{formatBytes(chunk.byteSize)}</td>
                  <td data-state={chunk.state}>{chunk.state}</td>
                  <td className="mono">
                    {chunk.checksum ? `${chunk.checksum.value.slice(0, 12)}…` : '—'}
                  </td>
                </tr>
              ))}
              {(state.manifest?.chunks ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No chunk finalized yet. A 30-second chunk becomes independently readable when it
                    is finalized.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        {state.recovery && state.recovery.sessions.length > 0 ? (
          <section className="panel recovery">
            <h2>Recovery</h2>
            {state.recovery.sessions.map((session) => (
              <article key={session.sessionId} data-interrupted={session.interrupted}>
                <header>
                  <strong>{session.directoryName}</strong>
                  <span>{session.state}</span>
                </header>
                <p>
                  {formatClock(session.canonicalDurationMs)} of meeting time ·{' '}
                  {session.durableChunkCount} durable chunk
                  {session.durableChunkCount === 1 ? '' : 's'}
                  {session.salvagedChunks > 0
                    ? ` · ${session.salvagedChunks} truncated-but-decodable`
                    : ''}
                  {session.orphanChunks > 0 ? ` · ${session.orphanChunks} adopted from disk` : ''} ·{' '}
                  {session.markerCount} markers · {session.noteCount} notes
                </p>
                <p className="hint">
                  {session.recoverable
                    ? 'Recoverable locally. Capture is never resumed into an old session, and nothing is deleted automatically.'
                    : 'Nothing durable found. The directory is kept for inspection.'}
                </p>
                {session.warnings.map((warning) => (
                  <p key={warning} className="warn">
                    {warning}
                  </p>
                ))}
              </article>
            ))}
            {state.recovery.rejected.length > 0 ? (
              <p className="warn">
                {state.recovery.rejected.length} session director
                {state.recovery.rejected.length === 1 ? 'y' : 'ies'} left untouched because the
                manifest could not be validated (unreadable or newer schema version).
              </p>
            ) : null}
          </section>
        ) : null}
      </main>

      <footer>
        <span>local-only · no upload, no transcription in this version</span>
        {state.status?.sessionDirectory ? (
          <span className="mono">session {state.status.sessionDirectory}</span>
        ) : null}
        {state.status?.persistenceFault ? (
          <span className="fault">persistence failed: {state.status.persistenceFault.code}</span>
        ) : null}
      </footer>
    </div>
  );
}

function isCapturingState(state: string): boolean {
  return state === 'recording' || state === 'paused' || state === 'finalizing';
}

export default App;
