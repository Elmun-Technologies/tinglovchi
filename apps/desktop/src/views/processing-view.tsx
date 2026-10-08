import { copy } from '../copy.ts';
import { processingHeadline } from '../flow.ts';

/** One quiet status line, advanced only by the actual local and backend recording states. */
export function ProcessingView({
  phase,
  productState,
}: {
  phase: 'stopping' | 'uploading' | 'saved_locally' | 'processing';
  productState: string | null;
}) {
  const title =
    phase === 'stopping' || phase === 'saved_locally'
      ? copy.after.saving
      : phase === 'uploading'
        ? copy.after.uploading
        : processingHeadline(productState ?? 'preparing', copy.after).title;

  return (
    <section className="stage stage-processing">
      <header className="stage-brand">
        <span className="wordmark">{copy.brand}</span>
      </header>

      <div className="stage-centre processing-centre" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <h2 className="processing-title">{title}</h2>
      </div>
    </section>
  );
}

/** A calm recovery state when the backend reports a real analysis failure. */
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
      <header className="stage-brand">
        <span className="wordmark">{copy.brand}</span>
      </header>
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
