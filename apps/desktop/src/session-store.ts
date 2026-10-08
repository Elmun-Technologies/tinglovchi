/**
 * Local desktop session and workspace memory.
 *
 * What is stored, and why it is safe to store in webview storage:
 * * an opaque, server-issued session token (the server keeps only its SHA-256, so a stolen local copy
 *   is revocable and expires on its own),
 * * the workspace list and the last workspace the user recorded into,
 * * whether the participant-notice consent has been acknowledged on this device.
 *
 * What is deliberately never stored here: passwords, Supabase keys, provider credentials, transcript
 * text, or audio. There is no credential a provider could use in this file.
 */

import type { WorkspaceSummaryDto } from '@suhbat/contracts';

const STORAGE_KEY = 'suhbat.desktop.v1';

export type StoredSession = {
  token: string | null;
  userId: string | null;
  userEmail: string | null;
  workspaces: WorkspaceSummaryDto[];
  /** Last workspace used on this device; re-validated against the server list before each start. */
  selectedWorkspaceId: string | null;
  consentAcknowledgedAt: string | null;
  sessionExpiresAt: string | null;
};

export const emptySession: StoredSession = {
  token: null,
  userId: null,
  userEmail: null,
  workspaces: [],
  selectedWorkspaceId: null,
  consentAcknowledgedAt: null,
  sessionExpiresAt: null,
};

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
        const parsed = JSON.parse(raw) as Partial<StoredSession>;
        return normalize(parsed);
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
    token: typeof input.token === 'string' && input.token.length > 0 ? input.token : null,
    userId: typeof input.userId === 'string' ? input.userId : null,
    userEmail: typeof input.userEmail === 'string' ? input.userEmail : null,
    workspaces,
    selectedWorkspaceId:
      typeof input.selectedWorkspaceId === 'string' &&
      workspaces.some((workspace) => workspace.id === input.selectedWorkspaceId)
        ? input.selectedWorkspaceId
        : null,
    consentAcknowledgedAt:
      typeof input.consentAcknowledgedAt === 'string' ? input.consentAcknowledgedAt : null,
    sessionExpiresAt: typeof input.sessionExpiresAt === 'string' ? input.sessionExpiresAt : null,
  };
}

/**
 * Which workspace the recorder should use, without ever asking twice:
 * the one the user chose last if still valid, the only workspace otherwise, and nothing if ambiguous.
 */
export function resolveWorkspace(session: StoredSession): WorkspaceSummaryDto | null {
  if (session.workspaces.length === 0) return null;
  if (session.selectedWorkspaceId) {
    const chosen = session.workspaces.find((w) => w.id === session.selectedWorkspaceId);
    if (chosen) return chosen;
  }
  return session.workspaces.length === 1 ? session.workspaces[0]! : null;
}

export function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Blocked storage (private mode, hardened webview) is survivable: the app will simply ask for
    // sign-in each launch rather than failing.
    return null;
  }
}
