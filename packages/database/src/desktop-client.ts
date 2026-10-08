import { createHash, randomBytes } from 'node:crypto';
import {
  desktopConnectCodeSchema,
  type DesktopSessionInfoResponse,
  type DesktopSessionResponse,
  type WorkspaceSummaryDto,
} from '@suhbat/contracts';
import { Phase4ServiceError, type AuthenticatedPrincipal } from './phase4-backbone';

/**
 * Desktop pairing, session, and automatic meeting-context service.
 *
 * Authorization model
 * -------------------
 * Every statement here reaches PostgreSQL through a narrowly scoped `security definer` function
 * (`supabase/migrations/202610080002_phase13_desktop_session_rotation.sql`), which is the pattern
 * this repository already uses for `public.create_workspace(text, text)`. This service therefore
 * needs **no direct database connection and no service-role credential**: it runs inside the web
 * process holding only the public anon key and, when there is one, the caller's own session.
 *
 * That matters because `docs/production-readiness.md` makes `SUPABASE_DB_URL` and
 * `SUPABASE_SERVICE_ROLE_KEY` forbidden in the Web deployment. The rules that keep this safe:
 *
 * * A caller can never name a user. The user id always comes from a credential we verified (a
 *   desktop access token hash) or from `auth.uid()` inside SQL — never from an argument.
 * * Credentials are opaque random strings. Only SHA-256 hashes cross into the database, and those
 *   hashes are computed here, in the application tier, so SQL never sees a plaintext credential.
 * * An access token is short-lived; a refresh token is long-lived but single-use (it rotates on every
 *   successful refresh) and revocable. There is no long-lived credential valid for ordinary requests.
 *
 * Nothing here reads or writes meeting content. It establishes identity and creates the meeting
 * container a recording will be attached to.
 */

export const DESKTOP_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DESKTOP_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DESKTOP_CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_POLL_INTERVAL_MS = 2_000;
/** Bounded so an anonymous caller cannot grow the pairing table without limit. */
export const DESKTOP_MAX_LIVE_CONNECT_CODES = 2_000;

/** Crockford-style alphabet: no I, L, O, U, so a code read aloud or typed is unambiguous. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUP_LENGTH = 4;
const CODE_GROUPS = 3;

const WORKSPACE_ROLE_VALUES = new Set(['owner', 'admin', 'member']);

/**
 * How this service talks to the database.
 *
 * Deliberately tiny: one method taking a function name and named arguments, returning the decoded
 * payload. The web app supplies a Supabase `rpc` implementation; the tests supply a PGlite one. No
 * connection string, driver, or table name ever appears on this side of the boundary.
 */
export type DesktopRpc = {
  call(fn: string, args?: Record<string, unknown>): Promise<unknown>;
};

type RpcFailure = { code: string; message: string };

/** Maps a database-raised SQLSTATE onto the API error vocabulary. */
function rpcFailure(cause: unknown, fallback: string): RpcFailure {
  const raw = cause as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code : '';
  const message =
    typeof raw?.message === 'string' && raw.message.trim() ? raw.message.trim() : fallback;
  return { code, message };
}

/**
 * Translates a Postgres error into the right HTTP status.
 *
 * `42501` is insufficient privilege (wrong workspace), `28000`/`28001` are "not authenticated" and
 * "session no longer valid", `P0002` is "no such row", and `22023` is an invalid parameter. Anything
 * unrecognised stays a 500 so a genuine bug is never reported to the client as a user mistake.
 */
function rpcError(cause: unknown, fallback: string): Phase4ServiceError {
  const { code, message } = rpcFailure(cause, fallback);
  if (code === '42501') return new Phase4ServiceError(403, 'unauthorized', message);
  if (code === '28000') return new Phase4ServiceError(401, 'unauthenticated', message);
  if (code === '28001') return new Phase4ServiceError(401, 'unauthorized', message);
  if (code === 'P0002') return new Phase4ServiceError(404, 'not_found', message);
  if (code === '22023') return new Phase4ServiceError(400, 'validation_failed', message);
  if (code === 'P0001') return new Phase4ServiceError(429, 'rate_limited', message);
  if (code === '23505' || code === '23503' || code === '23514') {
    return new Phase4ServiceError(409, 'idempotency_conflict', message);
  }
  return new Phase4ServiceError(500, 'internal_error', message);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 60 bits from a CSPRNG, grouped so a human can read it back without confusing glyphs. */
function randomCode(): string {
  const bytes = randomBytes(CODE_GROUP_LENGTH * CODE_GROUPS);
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let text = '';
    for (let index = 0; index < CODE_GROUP_LENGTH; index += 1) {
      text += CODE_ALPHABET[bytes[group * CODE_GROUP_LENGTH + index]! % CODE_ALPHABET.length];
    }
    groups.push(text);
  }
  return groups.join('-');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date().toISOString();
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === 'object') return [payload as Record<string, unknown>];
  return [];
}

function firstRow(payload: unknown): Record<string, unknown> | null {
  return rows(payload)[0] ?? null;
}

export type CreateDesktopConnectCodeResult = {
  code: string;
  status: 'pending';
  expiresAt: string;
  pollIntervalMs: number;
};

export type DesktopSessionContext = {
  userId: string;
  workspaceId: string | null;
};

export class DesktopClientService {
  private readonly rpc: DesktopRpc;

  constructor(options: { rpc: DesktopRpc }) {
    this.rpc = options.rpc;
  }

  /**
   * Mints a pairing code. Unauthenticated by design — the desktop has no credential yet — but the
   * row is worthless until a signed-in human approves it, and creation is bounded by a live-code
   * ceiling so an anonymous caller cannot use this to grow the table.
   */
  async createConnectCode(
    rawInput?: { clientLabel?: string },
  ): Promise<CreateDesktopConnectCodeResult> {
    const code = randomCode();
    let expiresAt: string;
    try {
      const row = firstRow(
        await this.rpc.call('desktop_create_connect_code', {
          p_code_hash: sha256Hex(code),
          p_client_label: rawInput?.clientLabel?.slice(0, 80) ?? null,
          p_ttl_seconds: Math.floor(DESKTOP_CONNECT_CODE_TTL_MS / 1000),
          p_max_live_codes: DESKTOP_MAX_LIVE_CONNECT_CODES,
        }),
      );
      if (!row) throw new Error('no row returned');
      expiresAt = toIso(row.expires_at);
    } catch (cause) {
      throw rpcError(cause, 'Could not create a pairing code.');
    }

    return { code, status: 'pending', expiresAt, pollIntervalMs: DESKTOP_POLL_INTERVAL_MS };
  }

  /**
   * Answers 'pending' for codes that do not exist, so a caller cannot probe for other devices. The
   * desktop stops polling on its own deadline rather than being told a code expired.
   */
  async connectCodeStatus(
    rawCode: string | null | undefined,
  ): Promise<{ status: 'pending' | 'authorized' | 'consumed'; pollIntervalMs: number }> {
    const parsed = desktopConnectCodeSchema.safeParse(rawCode);
    if (!parsed.success) return { status: 'pending', pollIntervalMs: DESKTOP_POLL_INTERVAL_MS };

    let status: string;
    try {
      const row = firstRow(
        await this.rpc.call('desktop_connect_code_status', { p_code_hash: sha256Hex(parsed.data) }),
      );
      status = typeof row?.status === 'string' ? row.status : 'pending';
    } catch (cause) {
      throw rpcError(cause, 'Could not read the pairing code status.');
    }
    return {
      status: status === 'authorized' || status === 'consumed' ? status : 'pending',
      pollIntervalMs: DESKTOP_POLL_INTERVAL_MS,
    };
  }

  /**
   * Binds an approved code to the approving user and a workspace they belong to.
   *
   * The user id comes from the caller's Supabase JWT inside SQL, so this can never be invoked on
   * behalf of somebody else.
   */
  async authorizeConnectCode(
    auth: AuthenticatedPrincipal | null | undefined,
    rawCode: string | null | undefined,
    workspaceId: unknown,
  ): Promise<{ code: string; status: 'authorized'; workspaceId: string }> {
    requireUserId(auth);
    const parsed = desktopConnectCodeSchema.safeParse(rawCode);
    if (!parsed.success) {
      throw new Phase4ServiceError(400, 'validation_failed', 'That is not a valid connect code.');
    }
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new Phase4ServiceError(400, 'validation_failed', 'A workspace is required.');
    }

    try {
      await this.rpc.call('desktop_authorize_connect_code', {
        p_code_hash: sha256Hex(parsed.data),
        p_workspace_id: workspaceId,
      });
    } catch (cause) {
      throw rpcError(cause, 'Could not approve that pairing code.');
    }
    return { code: parsed.data, status: 'authorized', workspaceId };
  }

  /**
   * Trades one approved code for a session.
   *
   * The single-use guarantee lives in the database: `desktop_exchange_connect_code` claims the code
   * with `UPDATE ... WHERE status = 'authorized' ... RETURNING` and inserts the session from that one
   * statement. Concurrent exchanges cannot both win, and a second attempt simply finds nothing to
   * claim and answers 404.
   */
  async exchangeConnectCode(
    rawInput: { code?: string; clientLabel?: string },
  ): Promise<DesktopSessionResponse> {
    const parsed = desktopConnectCodeSchema.safeParse(rawInput?.code);
    if (!parsed.success) {
      throw new Phase4ServiceError(400, 'validation_failed', 'That is not a valid connect code.');
    }

    const accessToken = randomToken();
    const refreshToken = randomToken();
    let row: Record<string, unknown> | null;
    try {
      row = firstRow(
        await this.rpc.call('desktop_exchange_connect_code', {
          p_code_hash: sha256Hex(parsed.data),
          p_access_token_hash: sha256Hex(accessToken),
          p_refresh_token_hash: sha256Hex(refreshToken),
          p_access_ttl_seconds: Math.floor(DESKTOP_ACCESS_TOKEN_TTL_MS / 1000),
          p_refresh_ttl_seconds: Math.floor(DESKTOP_REFRESH_TOKEN_TTL_MS / 1000),
          p_client_label: rawInput?.clientLabel?.slice(0, 80) ?? null,
        }),
      );
    } catch (cause) {
      throw rpcError(cause, 'Could not exchange that pairing code.');
    }
    if (!row) {
      throw new Phase4ServiceError(
        404,
        'not_found',
        'That pairing code has not been approved, has expired, or was already used.',
      );
    }

    const userId = String(row.user_id ?? '');
    const workspaces = await this.listWorkspaces(accessToken);
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(
        Date.now() + DESKTOP_ACCESS_TOKEN_TTL_MS,
      ).toISOString(),
      refreshTokenExpiresAt: toIso(row.refresh_token_expires_at),
      userId,
      userEmail: typeof row.user_email === 'string' ? row.user_email : null,
      defaultWorkspaceId:
        (typeof row.workspace_id === 'string' ? row.workspace_id : null) ??
        (workspaces.length === 1 ? workspaces[0]!.id : null),
      workspaces,
    };
  }

  /**
   * Rotates the refresh credential and issues a fresh access token.
   *
   * The presented refresh token stops working the moment this succeeds. Replaying a superseded one
   * fails, and replaying it well after the rotation revokes the whole session, because at that point
   * it is far more likely to be a stolen credential than a lost response.
   */
  async refreshSession(
    rawToken: string | null | undefined,
  ): Promise<DesktopSessionResponse> {
    if (typeof rawToken !== 'string' || rawToken.length < 32) {
      throw new Phase4ServiceError(401, 'unauthorized', 'That refresh token is not valid.');
    }

    const accessToken = randomToken();
    const refreshToken = randomToken();
    let row: Record<string, unknown> | null;
    try {
      row = firstRow(
        await this.rpc.call('desktop_refresh_session', {
          p_refresh_token_hash: sha256Hex(rawToken),
          p_new_access_token_hash: sha256Hex(accessToken),
          p_new_refresh_token_hash: sha256Hex(refreshToken),
          p_access_ttl_seconds: Math.floor(DESKTOP_ACCESS_TOKEN_TTL_MS / 1000),
          p_refresh_ttl_seconds: Math.floor(DESKTOP_REFRESH_TOKEN_TTL_MS / 1000),
        }),
      );
    } catch (cause) {
      throw rpcError(cause, 'Could not refresh that session.');
    }
    if (!row) {
      throw new Phase4ServiceError(
        401,
        'unauthorized',
        'That session is no longer valid. Sign in again.',
      );
    }

    const workspaces = await this.listWorkspaces(accessToken);
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + DESKTOP_ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshTokenExpiresAt: toIso(row.refresh_token_expires_at),
      userId: String(row.user_id ?? ''),
      userEmail: typeof row.user_email === 'string' ? row.user_email : null,
      defaultWorkspaceId:
        (typeof row.workspace_id === 'string' ? row.workspace_id : null) ??
        (workspaces.length === 1 ? workspaces[0]!.id : null),
      workspaces,
    };
  }

  /**
   * Resolves a short-lived access token to the user it belongs to.
   *
   * `desktop_session_context` deliberately still returns a row for an expired access token — the
   * client needs that to know it should refresh rather than re-authenticate. So the expiry check is
   * applied here: an expired access token authenticates nothing.
   */
  async resolveSessionToken(
    token: string | null | undefined,
  ): Promise<AuthenticatedPrincipal | null> {
    if (typeof token !== 'string' || token.length < 32) return null;
    const row = firstRow(
      await this.rpc.call('desktop_session_context', { p_access_token_hash: sha256Hex(token) }),
    );
    if (!row) return null;
    const userId = typeof row.user_id === 'string' ? row.user_id : '';
    if (!userId) return null;
    const expiresAt = Date.parse(toIso(row.access_token_expires_at));
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) return null;
    return { userId };
  }

  /** Logout. Accepts either credential, so a session can be dropped even if the access token died. */
  async revokeSessionToken(
    rawToken: string | null | undefined,
    kind: 'access' | 'refresh' = 'access',
  ): Promise<boolean> {
    if (typeof rawToken !== 'string' || rawToken.length < 32) return false;
    const result = await this.rpc.call('desktop_revoke_session', {
      p_access_token_hash: kind === 'access' ? sha256Hex(rawToken) : null,
      p_refresh_token_hash: kind === 'refresh' ? sha256Hex(rawToken) : null,
    });
    return result === true;
  }

  async describeSession(
    auth: AuthenticatedPrincipal | null | undefined,
    rawToken: string | null | undefined,
  ): Promise<DesktopSessionInfoResponse> {
    const userId = requireUserId(auth);
    const row = firstRow(
      await this.rpc.call('desktop_session_context', {
        p_access_token_hash: typeof rawToken === 'string' ? sha256Hex(rawToken) : null,
      }),
    );
    if (!row) {
      throw new Phase4ServiceError(401, 'unauthorized', 'That session is no longer valid.');
    }
    const workspaces = await this.listWorkspacesFor(rawToken);
    return {
      userId,
      userEmail: typeof row.user_email === 'string' ? row.user_email : null,
      defaultWorkspaceId:
        (typeof row.workspace_id === 'string' ? row.workspace_id : null) ??
        (workspaces.length === 1 ? workspaces[0]!.id : null),
      workspaces,
      expiresAt: toIso(row.refresh_token_expires_at),
    };
  }

  async rememberWorkspace(
    auth: AuthenticatedPrincipal | null | undefined,
    rawToken: string | null | undefined,
    workspaceId: unknown,
  ): Promise<void> {
    requireUserId(auth);
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new Phase4ServiceError(400, 'validation_failed', 'A workspace is required.');
    }
    try {
      await this.rpc.call('desktop_remember_workspace', {
        p_access_token_hash: typeof rawToken === 'string' ? sha256Hex(rawToken) : null,
        p_workspace_id: workspaceId,
      });
    } catch (cause) {
      throw rpcError(cause, 'Could not remember that workspace.');
    }
  }

  /**
   * Creates the meeting container a one-tap recording attaches to.
   *
   * Only `workspaceId` is required. A missing title becomes `Suhbat — 8 Oct, 14:32` and a missing
   * type becomes the workspace's own default, both decided in SQL so the choice cannot drift between
   * clients. `defaultsApplied` reports which ones were filled in.
   */
  async ensureMeeting(
    auth: AuthenticatedPrincipal | null | undefined,
    accessToken: string | null | undefined,
    rawInput: {
      workspaceId: string;
      title?: string;
      meetingTypeId?: string;
      companyId?: string | null;
      projectId?: string | null;
      startedAt?: string;
    },
  ): Promise<{
    meeting: {
      id: string;
      workspaceId: string;
      title: string;
      status: string;
      meetingTypeId: string;
      meetingTypeLabel: string;
      companyId: string | null;
      projectId: string | null;
      createdBy: string;
      startedAt: string;
      createdAt: string;
    };
    defaultsApplied: { title: boolean; meetingType: boolean };
  }> {
    requireUserId(auth);
    let row: Record<string, unknown> | null;
    try {
      row = firstRow(
        await this.rpc.call('desktop_ensure_meeting', {
          p_access_token_hash: typeof accessToken === 'string' ? sha256Hex(accessToken) : null,
          p_workspace_id: rawInput.workspaceId,
          p_title: rawInput.title ?? null,
          p_meeting_type_id: rawInput.meetingTypeId ?? null,
          p_company_id: rawInput.companyId ?? null,
          p_project_id: rawInput.projectId ?? null,
          p_started_at: rawInput.startedAt ?? null,
        }),
      );
    } catch (cause) {
      throw rpcError(cause, 'Could not create that meeting.');
    }
    if (!row) {
      throw new Phase4ServiceError(404, 'not_found', 'That session is no longer valid.');
    }
    return {
      meeting: {
        id: String(row.meeting_id ?? ''),
        workspaceId: String(row.workspace_id ?? ''),
        title: String(row.title ?? ''),
        status: String(row.status ?? 'draft'),
        meetingTypeId: String(row.meeting_type_id ?? ''),
        meetingTypeLabel: String(row.meeting_type_label ?? ''),
        companyId: row.company_id ? String(row.company_id) : null,
        projectId: row.project_id ? String(row.project_id) : null,
        createdBy: String(row.created_by ?? ''),
        startedAt: toIso(row.started_at),
        createdAt: toIso(row.created_at),
      },
      defaultsApplied: {
        title: row.defaults_title === true,
        meetingType: row.defaults_meeting_type === true,
      },
    };
  }

  /**
   * Lists the workspaces a desktop access token can reach.
   *
   * Pass `null` to resolve the caller from their Supabase session instead, which is what the browser
   * dashboard does. Either way the SQL never accepts a caller-supplied user id.
   */
  async listWorkspaces(accessToken: string | null): Promise<WorkspaceSummaryDto[]> {
    return this.listWorkspacesFor(accessToken);
  }

  private async listWorkspacesFor(
    accessToken: string | null | undefined,
  ): Promise<WorkspaceSummaryDto[]> {
    const payload = await this.rpc.call('desktop_list_workspaces', {
      p_access_token_hash: typeof accessToken === 'string' ? sha256Hex(accessToken) : null,
    });
    return rows(payload).map((row) => ({
        id: String(row.workspace_id ?? ''),
        name: String(row.name ?? ''),
        role: WORKSPACE_ROLE_VALUES.has(String(row.role))
          ? (String(row.role) as WorkspaceSummaryDto['role'])
          : 'member',
        defaultMeetingTypeId: row.default_meeting_type_id
          ? String(row.default_meeting_type_id)
          : null,
        defaultMeetingTypeLabel: row.default_meeting_type_label
          ? String(row.default_meeting_type_label)
          : null,
        meetingTypeCount: toNumber(row.meeting_type_count),
      }));
  }

}

export function requireUserId(auth: AuthenticatedPrincipal | null | undefined): string {
  if (!auth || typeof auth.userId !== 'string' || !auth.userId) {
    throw new Phase4ServiceError(
      401,
      'unauthenticated',
      'This desktop session is no longer valid. Sign in again.',
    );
  }
  return auth.userId;
}

/** Mirrors the SQL default so a client-generated title and a server-generated one look identical. */
export function defaultMeetingTitle(startedAt?: string, now = new Date()): string {
  const at = startedAt ? new Date(startedAt) : now;
  const when = Number.isNaN(at.getTime()) ? now : at;
  return `Suhbat — ${when.getDate()} ${MONTH_LABELS[when.getMonth()] ?? 'Jan'}, ${String(
    when.getHours(),
  ).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
