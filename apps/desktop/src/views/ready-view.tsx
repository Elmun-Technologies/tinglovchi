import { copy } from '../copy.ts';
import { formatClock } from '../state.ts';

const LANGUAGE_LABELS: Record<string, string> = {
  uz: "O‘zbek",
  ru: 'Русский',
  en: 'English',
  mixed: 'Aralash',
  unknown: 'Noma’lum',
};

/**
 * Ready: the meeting is processed and the result lives in the web dashboard.
 *
 * Everything shown here is a value the server returned: the title it stored, the canonical duration
 * the recorder finalized, and the languages the transcription provider actually detected. When a
 * language was not detected, the row says so rather than guessing.
 */
export function ReadyView({
  title,
  durationMs,
  languages,
  onOpenResult,
  onNewMeeting,
}: {
  title: string;
  durationMs: number | null;
  languages: string[];
  onOpenResult: () => void;
  onNewMeeting: () => void;
}) {
  const languageLabel =
    languages.length === 0
      ? copy.after.languagesUnknown
      : languages.map((code) => LANGUAGE_LABELS[code] ?? code.toUpperCase()).join(' · ');

  return (
    <section className="stage stage-ready">
      <div className="stage-centre">
        <span className="ready-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 className="ready-title">{copy.after.ready}</h2>
        <p className="ready-meeting-title">{title}</p>

        <dl className="ready-meta">
          <div>
            <dt>{copy.after.duration}</dt>
            <dd>{durationMs === null ? '—' : formatClock(durationMs)}</dd>
          </div>
          <div>
            <dt>{copy.after.languages}</dt>
            <dd>{languageLabel}</dd>
          </div>
        </dl>
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
