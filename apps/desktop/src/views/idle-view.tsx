import type { WorkspaceSummaryDto } from '@suhbat/contracts';
import { copy } from '../copy.ts';

/**
 * Idle: the entire product in one screen.
 *
 * Deliberately contains no forms, no analytics, no navigation, and no developer information — a user
 * must understand what to do within three seconds. Everything that is not the button is a single line
 * of context (which workspace) or a single escape hatch (settings).
 */
export function IdleView({
  workspace,
  workspaceCount,
  deviceReady,
  deviceLabel,
  canStart,
  starting,
  onStart,
  onOpenSettings,
  onSwitchWorkspace,
}: {
  workspace: WorkspaceSummaryDto | null;
  workspaceCount: number;
  deviceReady: boolean;
  deviceLabel: string;
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  onOpenSettings: () => void;
  onSwitchWorkspace: () => void;
}) {
  return (
    <section className="stage stage-idle">
      <header className="stage-brand">
        <span className="wordmark">SUHBAT</span>
        <span className="wordmark-sub">{copy.tagline}</span>
      </header>

      <div className="stage-centre">
        <button
          type="button"
          className={`mic-button ${starting ? 'is-starting' : ''}`}
          onClick={onStart}
          disabled={!canStart || starting}
          aria-label={copy.idle.start}
        >
          <span className="mic-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.7">
              <rect x="9" y="2.5" width="6" height="11" rx="3" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" strokeLinecap="round" />
              <path d="M12 18v3" strokeLinecap="round" />
            </svg>
          </span>
        </button>
        <p className="mic-label">{starting ? copy.idle.starting : copy.idle.start}</p>
      </div>

      <footer className="stage-footer">
        <button
          type="button"
          className="workspace-chip"
          onClick={onSwitchWorkspace}
          disabled={workspaceCount === 0}
          title={copy.idle.switchWorkspace}
        >
          <span className="workspace-dot" data-ready={Boolean(workspace)} />
          {workspace ? workspace.name : copy.idle.noWorkspace}
          {workspaceCount > 1 ? <span className="workspace-count">{workspaceCount}</span> : null}
        </button>

        <span className="device-line" data-ready={deviceReady}>
          {deviceLabel}
        </span>

        <button type="button" className="ghost-button" onClick={onOpenSettings} aria-label={copy.idle.settings}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3v2.2M12 18.8V21M4.8 7.5l1.9 1.1M17.3 15.4l1.9 1.1M4.8 16.5l1.9-1.1M17.3 8.6l1.9-1.1" strokeLinecap="round" />
          </svg>
        </button>
      </footer>
    </section>
  );
}
