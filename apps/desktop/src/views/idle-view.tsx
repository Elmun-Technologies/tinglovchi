import type { WorkspaceSummaryDto } from '@suhbat/contracts';
import { copy } from '../copy.ts';

/** The recorder's home: a name, one obvious action, and workspace context kept out of the way. */
export function IdleView({
  workspace,
  canStart,
  onStart,
  onOpenSettings,
}: {
  workspace: WorkspaceSummaryDto | null;
  canStart: boolean;
  onStart: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <section className="stage stage-idle">
      <header className="stage-brand">
        <span className="wordmark">{copy.brand}</span>
      </header>

      <div className="stage-centre idle-centre">
        <button
          type="button"
          className="mic-button"
          onClick={onStart}
          disabled={!canStart}
          aria-label={copy.idle.start}
        >
          <span className="mic-glyph" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="44"
              height="44"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.55"
            >
              <rect x="9" y="2.5" width="6" height="11" rx="3" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" strokeLinecap="round" />
              <path d="M12 18v3" strokeLinecap="round" />
            </svg>
          </span>
        </button>
        <h1 className="mic-label">{copy.idle.start}</h1>
        <p className="idle-hint">{copy.idle.hint}</p>
      </div>

      <footer className="stage-footer idle-footer">
        <span className="workspace-caption" title={workspace?.name}>
          {workspace?.name ?? ''}
        </span>
        <button
          type="button"
          className="ghost-button"
          onClick={onOpenSettings}
          aria-label={copy.idle.settings}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <circle cx="12" cy="12" r="3.2" />
            <path
              d="M12 3v2.2M12 18.8V21M4.8 7.5l1.9 1.1M17.3 15.4l1.9 1.1M4.8 16.5l1.9-1.1M17.3 8.6l1.9-1.1"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </footer>
    </section>
  );
}
