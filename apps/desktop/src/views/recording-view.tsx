import type { RecorderStatus } from '@suhbat/contracts';
import { SourcePill, Waveform } from '../components/waveform.tsx';
import { copy } from '../copy.ts';
import { formatClock } from '../state.ts';

/** Focused recorder controls and live capture feedback; no session or operator details. */
export function RecordingView({
  status,
  paused,
  canPause,
  canResume,
  canStop,
  onPause,
  onResume,
  onStop,
}: {
  status: RecorderStatus | null;
  paused: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const elapsed = status?.canonicalElapsedMs ?? 0;
  const mic = status?.sources.find((source) => source.kind === 'microphone') ?? null;
  const system = status?.sources.find((source) => source.kind === 'system_audio') ?? null;
  const micLevel = status?.levels.find((level) => level.kind === 'microphone') ?? null;

  return (
    <section className={`stage stage-recording ${paused ? 'is-paused' : ''}`}>
      <header className="stage-brand">
        <span className="wordmark">{copy.brand}</span>
      </header>

      <div className="stage-centre recording-centre">
        <div className="recording-status" data-paused={paused}>
          <span className="recording-dot" aria-hidden="true" />
          <span>{paused ? copy.paused.title : copy.recording.title}</span>
        </div>

        <div className="timer" role="timer" aria-live="off">
          {formatClock(elapsed)}
        </div>

        <Waveform level={micLevel} bars={24} tone={paused ? 'idle' : 'recording'} />

        <div className="source-pills" aria-label="Audio manbalari">
          <SourcePill label={copy.recording.mic} state={sourceState(mic?.state)} />
          <SourcePill label={copy.recording.system} state={sourceState(system?.state)} />
        </div>
      </div>

      <footer className="stage-footer stage-footer-controls">
        {paused ? (
          <button
            type="button"
            className="pill-button primary"
            onClick={onResume}
            disabled={!canResume}
          >
            {copy.recording.resume}
          </button>
        ) : (
          <button type="button" className="pill-button" onClick={onPause} disabled={!canPause}>
            {copy.recording.pause}
          </button>
        )}
        <button type="button" className="pill-button stop" onClick={onStop} disabled={!canStop}>
          {copy.recording.stop}
        </button>
      </footer>
    </section>
  );
}

function sourceState(
  state: 'starting' | 'active' | 'degraded' | 'unavailable' | undefined,
): 'active' | 'silent' | 'unavailable' {
  if (state === 'active') return 'active';
  if (!state || state === 'unavailable') return 'unavailable';
  return 'silent';
}
