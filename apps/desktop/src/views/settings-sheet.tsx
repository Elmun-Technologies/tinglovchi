import type { AudioDevice, WorkspaceSummaryDto } from '@suhbat/contracts';
import { copy } from '../copy.ts';

/**
 * Settings: everything the recorder needs, nothing it does not.
 *
 * There is no analytics, no debug panel, and no pipeline vocabulary here. The one paragraph of
 * "how this works" is written for a person, not an operator.
 */
export function SettingsSheet({
  workspaces,
  selectedWorkspaceId,
  devices,
  selectedDeviceUid,
  captureSystemAudio,
  systemAudioSupported,
  userEmail,
  onSelectWorkspace,
  onSelectDevice,
  onToggleSystemAudio,
  onSignOut,
  onClose,
}: {
  workspaces: WorkspaceSummaryDto[];
  selectedWorkspaceId: string | null;
  devices: AudioDevice[];
  selectedDeviceUid: string | null;
  captureSystemAudio: boolean;
  systemAudioSupported: boolean;
  userEmail: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectDevice: (uid: string | null) => void;
  onToggleSystemAudio: (value: boolean) => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-scrim" role="presentation" onClick={onClose}>
      <aside
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={copy.settings.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>{copy.settings.title}</h2>
          <button type="button" className="ghost-button" onClick={onClose} aria-label={copy.settings.close}>
            ×
          </button>
        </header>

        <div className="sheet-body">
          {workspaces.length > 1 ? (
            <label className="sheet-field">
              <span>{copy.settings.workspace}</span>
              <select
                value={selectedWorkspaceId ?? ''}
                onChange={(event) => onSelectWorkspace(event.target.value)}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="sheet-field">
            <span>{copy.settings.microphone}</span>
            <select
              value={selectedDeviceUid ?? ''}
              onChange={(event) => onSelectDevice(event.target.value || null)}
            >
              <option value="">Tizim odatiy mikrofoni</option>
              {devices.map((device) => (
                <option key={device.uid} value={device.uid} disabled={!device.isAvailable}>
                  {device.name}
                  {device.isDefault ? ' (odatiy)' : ''}
                  {device.isAvailable ? '' : ' — mavjud emas'}
                </option>
              ))}
            </select>
          </label>

          <label className="sheet-check">
            <input
              type="checkbox"
              checked={captureSystemAudio}
              disabled={!systemAudioSupported}
              onChange={(event) => onToggleSystemAudio(event.target.checked)}
            />
            <span>
              {copy.settings.systemAudioToggle}
              {systemAudioSupported ? '' : ` — ${copy.errors.systemAudioUnavailable}`}
            </span>
          </label>

          <p className="sheet-note">{copy.settings.localOnlyNote}</p>

          {userEmail ? (
            <p className="sheet-note">
              {copy.settings.signedInAs}: <strong>{userEmail}</strong>
            </p>
          ) : null}
        </div>

        <footer className="sheet-foot">
          <button type="button" className="pill-button danger" onClick={onSignOut}>
            {copy.settings.signOut}
          </button>
        </footer>
      </aside>
    </div>
  );
}
