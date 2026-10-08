/**
 * Local desktop session and workspace memory.
 *
 * ## This is not secure credential storage, and is not meant to be
 *
 * Webview `localStorage` is plaintext on disk, readable by anything running as the user, and it is
 * not a keychain. Nothing here should rely on it for confidentiality. It is a **temporary staging
 * implementation**: it exists so the recorder can be used at all before the native credential store
 * is wired up, and the shape of this module is deliberately narrow so that moving it is a small,
 * contained change rather than a rewrite.
 *
 * What keeps that acceptable:
 * * the access token is short-lived (~15 minutes), so a copy stolen from disk is nearly worthless;
 * * the refresh token is single-use — it rotates on every refresh, so a copied one stops working the
 *   first time the real client refreshes;
 * * the server stores only SHA-256 hashes, so a copy of the database cannot be replayed;
 * * signing out revokes the session server-side, which works even though the disk copy remains.
 *
 * The follow-up is to move {@link SessionStore} behind Tauri and keep the credentials in the macOS
 * Keychain / Windows Credential Manager, leaving everything else in this file untouched. See
 * `docs/recording.md` §9.4.
 *
 * ## What is stored
 *
 * * the two opaque session credentials (access + refresh);
 * * the workspace list and the last workspace the user recorded into;
 * * whether the participant-notice consent has been acknowledged on this device.
 *
 * Deliberately never stored here: passwords, Supabase keys, provider credentials, transcript text, or
 * audio. There is no credential a provider could use in this file.
 */

import type { WorkspaceSummaryDto } from '@suhbat/contracts';

const STORAGE_KEY = 'suhbat.desktop.v1';

export type StoredSession = {
  /**
   * Short-lived credential sent on every API request.
   *
   * Kept here only because there is no keychain bridge yet. See the file header.
   */
  accessToken: string | null;
  /**
   * Long-lived, single-use credential sent only to the refresh endpoint.
   *
   * Kept here only because there is no keychain bridge yet. It rotates on every successful refresh,
   * so the copy on disk is stale as soon as the app refreshes once.
   */
  refreshToken: string | null;
  userId: string | null;
  userEmail: string | null;
  workspaces: WorkspaceSummaryDto[];
  /** Last workspace used on this device; re-validated against the server list before each start. */
  selectedWorkspaceId: string | null;
  consentAcknowledgedAt: string | null;
  /** When the refresh credential stops being renewable. The access expiry is tracked separately. */
  sessionExpiresAt: string | null;
  accessTokenExpiresAt: string | null;
};

export const emptySession: StoredSession = {
  accessToken: null,
  refreshToken: null,
  userId: null,
  userEmail: null,
  workspaces: [],
  selectedWorkspaceId: null,
  consentAcknowledgedAt: null,
  sessionExpiresAt: null,
  accessTokenExpiresAt: null,
};

/**
 * The only surface the app uses to persist session state.
 *
 * Everything goes through this interface so the storage medium can be swapped for the OS keychain
 * without touching `App.tsx`, `cloud.ts`, or the flow reducer.
 */
export type SessionStore = {
  read(): StoredSession;
  write(next: StoredSession): void;
  clear(): void;
};

export function createSessionStore(storage: Storage | null = safeLocalStorage()): SessionStore {
  return {
    read() {
      if (!storage) return { ...emptySession };
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return { ...emptySession };
      try {
        const parsed = JSON.parse(raw) as Partial<StoredSession> & { token?: unknown };
        // Migration: a pre-rotation build stored one long-lived `token`. It must not be carried
        // forward — it is the exact credential shape this model replaces — so it is dropped and the
        // user simply signs in again.
        const migrated: Partial<StoredSession> = { ...parsed };
        if (typeof parsed.token === 'string') {
          migrated.accessToken = null;
          migrated.refreshToken = null;
        }
        return normalize(migrated);
      } catch {
        // Corrupt storage is not a reason to lose the ability to record; start clean and stay local.
        return { ...emptySession };
      }
    },
    write(next) {
      if (!storage) return;
      storage.setItem(STORAGE_KEY, JSON.stringify(normalize(next)));
    },
    clear() {
      if (!storage) return;
      storage.removeItem(STORAGE_KEY);
    },
  };
}

function normalize(input: Partial<StoredSession>): StoredSession {
  const workspaces = Array.isArray(input.workspaces)
    ? input.workspaces.filter(
        (workspace): workspace is WorkspaceSummaryDto =>
          Boolean(workspace) && typeof workspace.id === 'string' && typeof workspace.name === 'string',
      )
    : [];
  return {
    accessToken: credential(input.accessToken),
    refreshToken: credential(input.refreshToken),
    userId: typeof input.userId === 'string' ? input.userId : null,
    userEmail: typeof input.userEmail === 'string' ? input.userEmail : null,
    workspaces,
    selectedWorkspaceId:
      typeof input.selectedWorkspaceId === 'string' && input.selectedWorkspaceId
        ? input.selectedWorkspaceId
        : null,
    consentAcknowledgedAt:
      typeof input.consentAcknowledgedAt === 'string' ? input.consentAcknowledgedAt : null,
    sessionExpiresAt:
      typeof input.sessionExpiresAt === 'string' ? input.sessionExpiresAt : null,
    accessTokenExpiresAt:
      typeof input.accessTokenExpiresAt === 'string' ? input.accessTokenExpiresAt : null,
  };
}

function credential(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 32 ? value : null;
}

/** True when a stored access token is missing or close enough to expiry to be worth renewing. */
export function accessTokenNeedsRefresh(session: StoredSession, now = Date.now()): boolean {
  if (!session.refreshToken) return false;
  if (!session.accessToken) return true;
  if (!session.accessTokenExpiresAt) return true;
  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  if (Number.isNaN(expiresAt)) return true;
  // Renew a minute early so a request is never sent with a token that is about to die.
  return expiresAt - now < 60_000;
}

export function resolveWorkspace(session: StoredSession): WorkspaceSummaryDto | null {
  if (session.workspaces.length === 0) return null;
  if (session.selectedWorkspaceId) {
    const remembered = session.workspaces.find((w) => w.id === session.selectedWorkspaceId);
    if (remembered) return remembered;
  }
  return session.workspaces.length === 1 ? session.workspaces[0]! : null;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can be disabled by policy; the app still records locally without it.
    return null;
  }
}
