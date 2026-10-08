import { copy } from '../copy.ts';
import { formatClock } from '../state.ts';

/** A small handoff from the recorder to its finished Intelligence result in the browser. */
export function ReadyView({
  title,
  durationMs,
  onOpenResult,
  onNewMeeting,
}: {
  title: string;
  durationMs: number | null;
  onOpenResult: () => void;
  onNewMeeting: () => void;
}) {
  return (
    <section className="stage stage-ready">
      <header className="stage-brand">
        <span className="wordmark">{copy.brand}</span>
      </header>

      <div className="stage-centre ready-centre">
        <span className="ready-glyph" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="30"
            height="30"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
          >
            <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 className="ready-title">{copy.after.ready}</h2>
        <p className="ready-meeting-title">{title}</p>
        <p className="ready-duration">
          <span>{copy.after.duration}</span>
          <strong>{durationMs === null ? '—' : formatClock(durationMs)}</strong>
        </p>
      </div>

      <footer className="stage-footer stage-footer-controls ready-actions">
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
