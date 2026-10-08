import { copy } from '../copy.ts';
import { processingHeadline } from '../flow.ts';

/**
 * After Stop: saving → uploading → transcribing → analysing.
 *
 * No percentages anywhere. The backend cannot tell us how far through a transcription it is, so a
 * number would be invented. What it *can* tell us is which canonical step it is on, and that is
 * exactly what is rendered — sourced from `MeetingProcessingResponse.timeline.steps`, which the
 * pipeline builds from real recording/chunk/job rows.
 */
export function ProcessingView({
  phase,
  productState,
  steps,
  progress,
  offline,
  onOpenResult,
}: {
  phase: 'stopping' | 'uploading' | 'saved_locally' | 'processing';
  productState: string | null;
  steps: { key: string; label: string; state: 'done' | 'active' | 'pending' | 'failed' }[];
  progress: { verified: number; total: number } | null;
  offline: boolean;
  onOpenResult: () => void;
}) {
  const headline = processingHeadline(productState ?? 'preparing', copy.after);

  const title =
    phase === 'stopping'
      ? copy.after.saving
      : phase === 'saved_locally' || (phase === 'uploading' && offline)
        ? copy.after.savedLocally
        : phase === 'uploading'
          ? headline.title === copy.after.uploading
            ? copy.after.uploading
            : copy.after.uploading
          : headline.title;

  const detail =
    phase === 'saved_locally' || (phase === 'uploading' && offline)
      ? copy.after.offlineSaved
      : phase === 'uploading' && progress && progress.total > 0
        ? `${copy.after.uploadResume} · ${progress.verified}/${progress.total}`
        : phase === 'uploading'
          ? copy.after.uploadResume
          : null;

  return (
    <section className="stage stage-processing">
      <header className="stage-brand stage-brand-quiet">
        <span className="rec-badge is-working">
          <span className="rec-dot" />
          {copy.tagline}
        </span>
      </header>

      <div className="stage-centre">
        <div className="spinner" aria-hidden="true" />
        <h2 className="processing-title">{title}</h2>
        {detail ? <p className="processing-detail">{detail}</p> : null}

        {steps.length > 0 ? (
          <ol className="step-list">
            {steps.map((step) => (
              <li key={step.key} data-state={step.state}>
                <span className="step-marker" aria-hidden="true" />
                <span className="step-label">{step.label}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <footer className="stage-footer">
        <button type="button" className="ghost-button" onClick={onOpenResult}>
          {copy.after.viewResult}
        </button>
      </footer>
    </section>
  );
}

/** Shown when the meeting is saved but transcription or analysis stopped without succeeding. */
export function AnalysisFailedView({
  notice,
  onOpenResult,
  onNewMeeting,
}: {
  notice: string;
  onOpenResult: () => void;
  onNewMeeting: () => void;
}) {
  return (
    <section className="stage stage-processing">
      <div className="stage-centre">
        <span className="big-glyph" aria-hidden="true">
          ✓
        </span>
        <h2 className="processing-title">{copy.after.failed}</h2>
        <p className="processing-detail">{notice}</p>
      </div>
      <footer className="stage-footer stage-footer-controls">
        <button type="button" className="pill-button primary" onClick={onOpenResult}>
          {copy.after.viewResult}
        </button>
        <button type="button" className="pill-button" onClick={onNewMeeting}>
          {copy.after.newMeeting}
        </button>
      </footer>
    </section>
  );
}
