import { useState } from 'react';
import { copy } from '../copy.ts';

/**
 * One-time participant notice.
 *
 * Recording two sources without telling anyone is not a detail to bury in a settings screen, so the
 * acknowledgement is asked for once, plainly, and then remembered on this device. It is shown again
 * after a sign-out — remembering consent across users would be the wrong default.
 */
export function ConsentView({ onAccept }: { onAccept: () => void }) {
  const [accepted, setAccepted] = useState(false);

  return (
    <section className="stage stage-consent">
      <div className="stage-centre">
        <span className="big-glyph" aria-hidden="true">
          ●
        </span>
        <h2 className="auth-title">{copy.consent.title}</h2>
        <p className="auth-body">{copy.consent.body}</p>

        <label className="consent-row">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>{copy.consent.checkbox}</span>
        </label>

        <button type="button" className="pill-button primary" onClick={onAccept} disabled={!accepted}>
          {copy.consent.accept}
        </button>
      </div>
    </section>
  );
}
