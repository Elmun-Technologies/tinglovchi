import { copy } from '../copy.ts';

/**
 * Sign-in: one button, one code, one browser visit.
 *
 * The desktop never sees a password. It asks the server for a short-lived pairing code, the user
 * approves it in a browser session they already have, and the app trades the approved code for its own
 * revocable session. That is the whole reason nothing in this app can leak a credential it never held.
 */
export function SignInView({
  phase,
  code,
  error,
  busy,
  canOpenBrowser,
  onRequestCode,
  onOpenBrowser,
  onCancel,
}: {
  phase: 'idle' | 'waiting';
  code: string | null;
  error: string | null;
  busy: boolean;
  canOpenBrowser: boolean;
  onRequestCode: () => void;
  onOpenBrowser: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="stage stage-auth">
      <header className="stage-brand">
        <span className="wordmark">SUHBAT</span>
        <span className="wordmark-sub">{copy.tagline}</span>
      </header>

      <div className="stage-centre">
        {phase === 'idle' ? (
          <>
            <h2 className="auth-title">{copy.auth.title}</h2>
            <p className="auth-body">{copy.auth.body}</p>
            <button type="button" className="pill-button primary" onClick={onRequestCode} disabled={busy}>
              {busy ? copy.auth.creating : copy.auth.createCode}
            </button>
          </>
        ) : (
          <>
            <h2 className="auth-title">{copy.auth.codeLabel}</h2>
            <p className="auth-code">{code ?? '••••-••••-••••'}</p>
            <p className="auth-body">{copy.auth.waiting}</p>
            <div className="auth-actions">
              <button
                type="button"
                className="pill-button primary"
                onClick={onOpenBrowser}
                disabled={!canOpenBrowser || !code}
              >
                {copy.auth.openBrowser}
              </button>
              <button type="button" className="pill-button" onClick={onCancel}>
                Bekor qilish
              </button>
            </div>
            {!canOpenBrowser && code ? (
              <p className="auth-fallback">
                Brauzerni ochib <strong>/desktop/connect</strong> sahifasiga o‘ting va shu kodni kiriting.
              </p>
            ) : null}
          </>
        )}
        {error ? <p className="auth-error">{error}</p> : null}
      </div>

      <footer className="stage-footer">
        <span className="device-line">
          Parol ilovaga kiritilmaydi — tasdiqlash brauzerda bo‘ladi.
        </span>
      </footer>
    </section>
  );
}
