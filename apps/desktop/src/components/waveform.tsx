import type { SourceLevel } from '@suhbat/contracts';

/**
 * Audio activity bars.
 *
 * Two honesty rules encoded here:
 * * A source that is not delivering audio (`live === false`) renders flat and labelled "—", never a
 *   resting-but-present waveform. Silence and absence are different facts.
 * * The bars come from real peak/RMS measurements emitted by the capture layer. Nothing here is
 *   animated when there is no signal to animate.
 */
export function Waveform({
  level,
  bars = 28,
  tone = 'recording',
}: {
  level: SourceLevel | null;
  bars?: number;
  tone?: 'recording' | 'idle';
}) {
  const live = Boolean(level?.live);
  const peak = live ? (level?.peak ?? 0) : 0;
  const rms = live ? (level?.rms ?? 0) : 0;

  return (
    <div className={`waveform ${live ? 'is-live' : 'is-silent'}`} data-tone={tone} aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => {
        const centre = Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2);
        const shape = 1 - centre * centre * 0.75;
        const height = live ? Math.max(6, Math.min(100, (rms * 70 + peak * 55) * shape * 100)) : 4;
        return (
          <span
            key={index}
            className="waveform-bar"
            style={{ height: `${height.toFixed(1)}%`, animationDelay: `${(index % 7) * 90}ms` }}
          />
        );
      })}
    </div>
  );
}

/** Compact "is this source capturing" pill used in the recording header. */
export function SourcePill({
  label,
  state,
}: {
  label: string;
  state: 'active' | 'silent' | 'unavailable';
}) {
  const text =
    state === 'active' ? label : state === 'silent' ? `${label} — jim` : `${label} — yo‘q`;
  return (
    <span className="source-pill" data-state={state}>
      <span className="source-dot" />
      {text}
    </span>
  );
}
