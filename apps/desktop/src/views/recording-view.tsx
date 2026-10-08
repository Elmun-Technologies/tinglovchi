import type { RecorderStatus, SourceLevel } from '@suhbat/contracts';
import { SourcePill, Waveform } from '../components/waveform.tsx';
import { copy } from '../copy.ts';
import { formatClock, meterPercent } from '../state.ts';

/**
 * Recording and paused: the only screen a user should have to look at for an hour.
 *
 * The timer is never computed in JavaScript — `canonicalElapsedMs` comes from the recorder's monotonic
 * meeting clock, which already accounts for pauses and gaps (docs/recording.md §3). Both sources are
 * shown separately because microphone-only capture is a legitimate, non-broken outcome.
 */
export function RecordingView({
  status,
  paused,
  canPause,
  canResume,
  canStop,
  stopping,
  onPause,
  onResume,
  onStop,
}: {
  status: RecorderStatus | null;
  paused: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
  stopping: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const elapsed = status?.canonicalElapsedMs ?? 0;
  const mic = status?.sources.find((source) => source.kind === 'microphone') ?? null;
  const system = status?.sources.find((source) => source.kind === 'system_audio') ?? null;
  const micLevel = status?.levels.find((level) => level.kind === 'microphone') ?? null;
  const systemLevel = status?.levels.find((level) => level.kind === 'system_audio') ?? null;

  return (
    <section className={`stage stage-recording ${paused ? 'is-paused' : ''}`}>
      <header className="stage-brand stage-brand-quiet">
        <span className="rec-badge" data-paused={paused}>
          <span className="rec-dot" />
          {paused ? copy.paused.title : copy.recording.title}
        </span>
      </header>

      <div className="stage-centre">
        <div className="timer" role="timer" aria-live="off">
          {formatClock(elapsed)}
        </div>
        {paused ? <p className="timer-hint">{copy.paused.hint}</p> : null}

        <Waveform level={micLevel} tone={paused ? 'idle' : 'recording'} />

        <div className="source-pills">
          <SourcePill
            label={copy.recording.mic}
            state={sourceState(mic?.state, micLevel)}
          />
          <SourcePill
            label={copy.recording.system}
            state={sourceState(system?.state, systemLevel)}
          />
        </div>
      </div>

      <footer className="stage-footer stage-footer-controls">
        {paused ? (
          <button type="button" className="pill-button primary" onClick={onResume} disabled={!canResume}>
            {copy.recording.resume}
          </button>
        ) : (
          <button type="button" className="pill-button" onClick={onPause} disabled={!canPause}>
            {copy.recording.pause}
          </button>
        )}
        <button type="button" className="pill-button stop" onClick={onStop} disabled={!canStop || stopping}>
          {stopping ? copy.recording.stopping : copy.recording.stop}
        </button>
      </footer>

      <div className="meters" aria-hidden="true">
        <div className="meter">
          <div className="meter-fill" style={{ width: `${meterPercent(micLevel)}%` }} />
        </div>
        <div className="meter">
          <div className="meter-fill" style={{ width: `${meterPercent(systemLevel)}%` }} />
        </div>
      </div>
    </section>
  );
}

function sourceState(
  state: 'starting' | 'active' | 'degraded' | 'unavailable' | undefined,
  level: SourceLevel | null,
): 'active' | 'silent' | 'unavailable' {
  if (!state || state === 'unavailable') return 'unavailable';
  if (!level?.live) return 'silent';
  return 'active';
}
