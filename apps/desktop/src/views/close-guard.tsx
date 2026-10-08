import { copy } from '../copy.ts';

/**
 * Shown when the window is closed mid-capture.
 *
 * The close has already been prevented in Rust before this renders, so the only two outcomes are
 * "stop and save" (finalize, then quit) and "cancel" (keep recording). There is no third button that
 * quits without finalizing: losing an hour of someone's meeting is not an option the UI should offer.
 */
export function CloseGuard({
  busy,
  onStopAndSave,
  onCancel,
}: {
  busy: boolean;
  onStopAndSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="sheet-scrim" role="presentation">
      <aside className="sheet sheet-confirm" role="dialog" aria-modal="true" aria-label={copy.close.title}>
        <header className="sheet-head">
          <h2>{copy.close.title}</h2>
        </header>
        <div className="sheet-body">
          <p className="sheet-note">{copy.close.body}</p>
        </div>
        <footer className="sheet-foot sheet-foot-split">
          <button type="button" className="pill-button" onClick={onCancel} disabled={busy}>
            {copy.close.cancel}
          </button>
          <button type="button" className="pill-button stop" onClick={onStopAndSave} disabled={busy}>
            {busy ? copy.recording.stopping : copy.close.stopAndSave}
          </button>
        </footer>
      </aside>
    </div>
  );
}
