import { createHash, randomBytes } from 'node:crypto';
import {
  desktopConnectCodeSchema,
  type DesktopSessionInfoResponse,
  type DesktopSessionResponse,
  type WorkspaceSummaryDto,
} from '@suhbat/contracts';
import {
  Phase4ServiceError,
  type AuthenticatedPrincipal,
  type SqlExecutor,
} from './phase4-backbone';

/**
 * Desktop pairing, session, and automatic meeting-context service.
 *
 * Everything reachable from the desktop app funnels through here so the authorization story stays
 * auditable in one file:
 *
 * * A connect code is minted without authentication (device-flow shaped) but is worthless until a
 *   signed-in human approves it in a browser. Only the SHA-256 of the code is persisted.
 * * Exchanging an approved code mints an opaque session token, also stored only as a SHA-256.
 * * Every other desktop call resolves that token back to a `userId`, and *then* runs the exact same
 *   workspace-membership and meeting-ownership checks the web dashboard runs. There is no
 *   desktop-only privilege and no bypass around RLS.
 *
 * Nothing here reads or writes meeting content; it only establishes identity and creates the
 * meeting container a recording will be attached to.
 */

const CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
/** Crockford-style alphabet: no I, L, O, U, so a code read aloud or typed is unambiguous. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_GROUP_LENGTH = 4;
const CODE_GROUPS = 3;

const WORKSPACE_ROLE_VALUES = new Set(['owner', 'admin', 'member']);

export type DesktopConnectCodeRow = {
  id: string;
  code_hash: string;
  status: 'pending' | 'authorized' | 'consumed' | 'expired';
  user_id: string | null;
  workspace_id: string | null;
  client_label: string | null;
  created_at: unknown;
  expires_at: unknown;
  authorized_at: unknown;
  consumed_at: unknown;
};

export type DesktopSessionRow = {
  id: string;
  token_hash: string;
  user_id: string;
  last_workspace_id: string | null;
  client_label: string | null;
  created_at: unknown;
  last_used_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
};

export type WorkspaceSummaryRow = {
  id: string;
  name: string;
  role: string;
  default_meeting_type_id: string | null;
  default_meeting_type_label: string | null;
  meeting_type_count: number | string;
};

export type DesktopMeetingRow = {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  meeting_type_id: string;
  company_id: string | null;
  project_id: string | null;
  created_by: string;
  started_at: unknown;
  created_at: unknown;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
  return new Date(String(value)).toISOString();
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type CreateDesktopConnectCodeResult = {
  code: string;
  status: 'pending';
  expiresAt: string;
  pollIntervalMs: number;
};

export class DesktopClientService {
  private readonly db: SqlExecutor;

  constructor(options: { db: SqlExecutor }) {
    this.db = options.db;
  }

  /**
   * Step 1 — mint a pairing code. Deliberately unauthenticated: the desktop has no credential yet.
   * The code is high-entropy, expires in ten minutes, and is useless until a human approves it.
   */
  async createConnectCode(rawInput?: {
    clientLabel?: string;
  }): Promise<CreateDesktopConnectCodeResult> {
    const clientLabel = rawInput?.clientLabel?.trim().slice(0, 80) || null;
    const code = randomCode();
    const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MS);

    await this.db.query(
      `insert into public.desktop_connect_codes
         (code_hash, status, client_label, expires_at)
       values ($1, 'pending', $2, $3)`,
      [sha256Hex(code), clientLabel, expiresAt.toISOString()],
    );

    return {
      code,
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      pollIntervalMs: POLL_INTERVAL_MS,
    };
  }

  /**
   * Polling read for the desktop: is the code I am holding approved yet?
   *
   * Deliberately lossy. `pending`, `expired`, and `unknown` all answer `pending` to the caller, so
   * this endpoint cannot be used to discover which codes exist. It never reveals a user or workspace.
   */
  async connectCodeStatus(rawCode: string | null | undefined): Promise<{
    status: 'pending' | 'authorized' | 'consumed';
    pollIntervalMs: number;
  }> {
    if (!rawCode) return { status: 'pending', pollIntervalMs: POLL_INTERVAL_MS };
    const parsed = desktopConnectCodeSchema.safeParse(rawCode);
    if (!parsed.success) return { status: 'pending', pollIntervalMs: POLL_INTERVAL_MS };
    const res = await this.db.query<DesktopConnectCodeRow>(
      `select * from public.desktop_connect_codes where code_hash = $1`,
      [sha256Hex(parsed.data.toUpperCase())],
    );
    const row = res.rows[0];
    if (!row) return { status: 'pending', pollIntervalMs: POLL_INTERVAL_MS };
    if (row.status === 'authorized') return { status: 'authorized', pollIntervalMs: POLL_INTERVAL_MS };
    if (row.status === 'consumed') return { status: 'consumed', pollIntervalMs: POLL_INTERVAL_MS };
    return { status: 'pending', pollIntervalMs: POLL_INTERVAL_MS };
  }

  /**
   * Step 2 — a signed-in human approves a code in the browser. Requires an authenticated principal
   * and an active membership in the workspace being granted.
   */
  async authorizeConnectCode(
    authInput: AuthenticatedPrincipal | null | undefined,
    rawCode: string,
    workspaceId?: string | null,
  ): Promise<{ status: 'authorized'; workspaceId: string | null }> {
    const userId = requireUserId(authInput);
    const parsed = desktopConnectCodeSchema.safeParse(rawCode);
    if (!parsed.success) {
      throw new Phase4ServiceError(400, 'validation_failed', 'That is not a valid connect code.');
    }
    const code = parsed.data.toUpperCase();

    const resolvedWorkspaceId = workspaceId
      ? await this.assertActiveMembership(userId, workspaceId)
      : await this.firstWorkspaceId(userId);
    if (!resolvedWorkspaceId) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        'You do not belong to an active workspace yet. Create one before connecting the desktop app.',
      );
    }

    const now = new Date();
    const res = await this.db.query<DesktopConnectCodeRow>(
      `update public.desktop_connect_codes
          set status = 'authorized',
              user_id = $2,
              workspace_id = $3,
              authorized_at = $4
        where code_hash = $1
          and status = 'pending'
          and expires_at > $4
        returning *`,
      [sha256Hex(code), userId, resolvedWorkspaceId, now.toISOString()],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Phase4ServiceError(
        404,
        'not_found',
        'That code is not waiting for approval. It may have expired or already been used — request a new one in the app.',
      );
    }
    return { status: 'authorized', workspaceId: resolvedWorkspaceId };
  }

  /**
   * Step 3 — exchange an approved code for a session token. Single use: the code burns here, and the
   * plaintext token is returned exactly once and never stored.
   */
  async exchangeConnectCode(rawInput: {
    code: string;
    clientLabel?: string;
  }): Promise<DesktopSessionResponse> {
    const parsed = desktopConnectCodeSchema.safeParse(rawInput?.code);
    if (!parsed.success) {
      throw new Phase4ServiceError(400, 'validation_failed', 'That is not a valid connect code.');
    }
    const code = parsed.data.toUpperCase();
    const clientLabel = rawInput?.clientLabel?.trim().slice(0, 80) || null;
    const now = new Date();

    const res = await this.db.query<DesktopConnectCodeRow>(
      `select * from public.desktop_connect_codes where code_hash = $1`,
      [sha256Hex(code)],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'authorized' || !row.user_id) {
      throw new Phase4ServiceError(
        404,
        'not_found',
        'That code has not been approved yet. Open the link in the app, sign in, and approve it.',
      );
    }
    if (new Date(toIso(row.expires_at)).getTime() <= now.getTime()) {
      await this.db.query(
        `update public.desktop_connect_codes set status = 'expired' where id = $1 and status = 'authorized'`,
        [row.id],
      );
      throw new Phase4ServiceError(404, 'not_found', 'That code expired. Request a new one.');
    }

    const token = randomToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db.query(
      `insert into public.desktop_sessions
         (token_hash, user_id, last_workspace_id, client_label, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [
        sha256Hex(token),
        row.user_id,
        row.workspace_id,
        clientLabel ?? row.client_label,
        expiresAt.toISOString(),
      ],
    );
    await this.db.query(
      `update public.desktop_connect_codes
          set status = 'consumed', consumed_at = $2
        where id = $1 and status = 'authorized'`,
      [row.id, now.toISOString()],
    );

    const workspaces = await this.listWorkspaces(row.user_id);
    return {
      token,
      userId: row.user_id,
      userEmail: await this.userEmail(row.user_id),
      defaultWorkspaceId:
        row.workspace_id && workspaces.some((workspace) => workspace.id === row.workspace_id)
          ? row.workspace_id
          : (workspaces[0]?.id ?? null),
      workspaces,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Resolves an `Authorization: Bearer <token>` header back to a principal. Expired, revoked, and
   * unknown tokens are all the same answer to the client, so the endpoint cannot be used to probe
   * which users have sessions.
   */
  async resolveSessionToken(token: string | null | undefined): Promise<AuthenticatedPrincipal | null> {
    if (!token || typeof token !== 'string' || token.length < 32 || token.length > 512) return null;
    const now = new Date();
    const res = await this.db.query<DesktopSessionRow>(
      `update public.desktop_sessions
          set last_used_at = $2
        where token_hash = $1
          and revoked_at is null
          and expires_at > $2
        returning *`,
      [sha256Hex(token), now.toISOString()],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { userId: row.user_id };
  }

  async revokeSessionToken(token: string | null | undefined): Promise<boolean> {
    if (!token || typeof token !== 'string') return false;
    const res = await this.db.query(
      `update public.desktop_sessions
          set revoked_at = $2
        where token_hash = $1 and revoked_at is null
        returning id`,
      [sha256Hex(token), new Date().toISOString()],
    );
    return res.rows.length > 0;
  }

  /**
   * `GET /api/v1/desktop/session` — who am I, which workspaces may I record into, and which one
   * should be preselected.
   */
  async describeSession(
    authInput: AuthenticatedPrincipal | null | undefined,
    rawToken: string | null | undefined,
  ): Promise<DesktopSessionInfoResponse> {
    const userId = requireUserId(authInput);
    const workspaces = await this.listWorkspaces(userId);
    const expiresAt = await this.sessionExpiry(rawToken);
    const preferred = await this.preferredWorkspaceId(userId);
    return {
      userId,
      userEmail: await this.userEmail(userId),
      defaultWorkspaceId:
        preferred && workspaces.some((workspace) => workspace.id === preferred)
          ? preferred
          : (workspaces[0]?.id ?? null),
      workspaces,
      expiresAt,
    };
  }

  /**
   * Records which workspace the recorder used last, so the next one-tap start does not ask again.
   * Membership is re-checked on every call, so a stale local choice can never widen access.
   */
  async rememberWorkspace(
    authInput: AuthenticatedPrincipal | null | undefined,
    rawToken: string | null | undefined,
    workspaceId: string,
  ): Promise<void> {
    const userId = requireUserId(authInput);
    await this.assertActiveMembership(userId, workspaceId);
    if (!rawToken) return;
    await this.db.query(
      `update public.desktop_sessions
          set last_workspace_id = $2, last_used_at = $3
        where token_hash = $1 and revoked_at is null`,
      [sha256Hex(rawToken), workspaceId, new Date().toISOString()],
    );
  }

  /**
   * Automatic meeting context for one-tap recording.
   *
   * Only `workspaceId` is required. A missing title becomes `Suhbat — 8 Oct, 14:32` (UTC, from the
   * start instant when supplied), a missing type becomes the workspace's own default, and
   * company/project stay null. A recording is never blocked by an unfilled form.
   */
  async ensureMeeting(
    authInput: AuthenticatedPrincipal | null | undefined,
    rawInput: {
      workspaceId: string;
      title?: string;
      meetingTypeId?: string;
      companyId?: string | null;
      projectId?: string | null;
      startedAt?: string;
      source?: 'desktop_recorder';
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
    const userId = requireUserId(authInput);
    const workspaceId = await this.assertActiveMembership(userId, rawInput?.workspaceId);
    await this.assertHierarchyInWorkspace(
      workspaceId,
      rawInput?.companyId ?? null,
      rawInput?.projectId ?? null,
    );

    const typeRes = await this.db.query<{ id: string; display_name: string }>(
      `select id, display_name
         from public.meeting_types
        where workspace_id = $1
          and is_active
          and ($2::uuid is null or id = $2::uuid)
        order by sort_order asc, created_at asc
        limit 1`,
      [workspaceId, rawInput?.meetingTypeId ?? null],
    );
    const meetingType = typeRes.rows[0];
    if (!meetingType) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        rawInput?.meetingTypeId
          ? 'That meeting type does not belong to this workspace.'
          : 'This workspace has no active meeting type. Add one in workspace settings.',
      );
    }

    const suppliedTitle = typeof rawInput?.title === 'string' ? rawInput.title.trim() : '';
    const defaultsTitle = suppliedTitle.length < 2;
    const title = defaultsTitle ? defaultMeetingTitle(rawInput?.startedAt) : suppliedTitle.slice(0, 180);

    const startedAt = rawInput?.startedAt ? safeIso(rawInput.startedAt) : new Date().toISOString();

    const insertRes = await this.db.query<DesktopMeetingRow>(
      `insert into public.meetings
         (workspace_id, meeting_type_id, title, created_by, started_at, company_id, project_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, workspace_id, title, status, meeting_type_id,
                 company_id, project_id, created_by, started_at, created_at`,
      [
        workspaceId,
        meetingType.id,
        title,
        userId,
        startedAt,
        rawInput?.companyId ?? null,
        rawInput?.projectId ?? null,
      ],
    );
    const meeting = insertRes.rows[0]!;

    return {
      meeting: {
        id: meeting.id,
        workspaceId: meeting.workspace_id,
        title: meeting.title,
        status: meeting.status,
        meetingTypeId: meeting.meeting_type_id,
        meetingTypeLabel: meetingType.display_name,
        companyId: meeting.company_id,
        projectId: meeting.project_id,
        createdBy: meeting.created_by,
        startedAt: toIso(meeting.started_at),
        createdAt: toIso(meeting.created_at),
      },
      defaultsApplied: { title: defaultsTitle, meetingType: !rawInput?.meetingTypeId },
    };
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummaryDto[]> {
    const res = await this.db.query<WorkspaceSummaryRow>(
      `select w.id,
              w.name,
              m.role::text as role,
              t.id as default_meeting_type_id,
              t.display_name as default_meeting_type_label,
              coalesce(tc.count, 0) as meeting_type_count
         from public.workspace_members as m
         join public.workspaces as w on w.id = m.workspace_id
         left join lateral (
           select mt.id, mt.display_name
             from public.meeting_types as mt
            where mt.workspace_id = w.id and mt.is_active
            order by mt.sort_order asc, mt.created_at asc
            limit 1
         ) as t on true
         left join lateral (
           select count(*) as count
             from public.meeting_types as mt2
            where mt2.workspace_id = w.id and mt2.is_active
         ) as tc on true
        where m.user_id = $1
          and m.membership_status = 'active'
        order by w.created_at asc, w.name asc`,
      [userId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: WORKSPACE_ROLE_VALUES.has(row.role) ? (row.role as WorkspaceSummaryDto['role']) : 'member',
      defaultMeetingTypeId: row.default_meeting_type_id,
      defaultMeetingTypeLabel: row.default_meeting_type_label,
      meetingTypeCount: toNumber(row.meeting_type_count),
    }));
  }

  private async assertActiveMembership(userId: string, workspaceId: unknown): Promise<string> {
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new Phase4ServiceError(400, 'validation_failed', 'A workspace is required.');
    }
    const res = await this.db.query<{ role: string }>(
      `select role::text as role
         from public.workspace_members
        where workspace_id = $1 and user_id = $2 and membership_status = 'active'`,
      [workspaceId, userId],
    );
    if (!res.rows[0]) {
      throw new Phase4ServiceError(
        403,
        'unauthorized',
        'You are not an active member of that workspace.',
      );
    }
    return workspaceId;
  }

  /**
   * Company/project stay optional, but when the client does send them they must live in the same
   * workspace. Checked explicitly so the caller gets a 400 they can act on instead of a raw
   * foreign-key violation; the composite FKs remain the backstop.
   */
  private async assertHierarchyInWorkspace(
    workspaceId: string,
    companyId: string | null,
    projectId: string | null,
  ): Promise<void> {
    if (companyId) {
      const res = await this.db.query<{ id: string }>(
        `select id from public.companies where id = $1 and workspace_id = $2`,
        [companyId, workspaceId],
      );
      if (!res.rows[0]) {
        throw new Phase4ServiceError(
          400,
          'validation_failed',
          'That company does not belong to this workspace.',
        );
      }
    }
    if (projectId) {
      const res = await this.db.query<{ id: string }>(
        `select id from public.projects where id = $1 and workspace_id = $2`,
        [projectId, workspaceId],
      );
      if (!res.rows[0]) {
        throw new Phase4ServiceError(
          400,
          'validation_failed',
          'That project does not belong to this workspace.',
        );
      }
    }
  }

  private async firstWorkspaceId(userId: string): Promise<string | null> {
    const workspaces = await this.listWorkspaces(userId);
    return workspaces[0]?.id ?? null;
  }

  private async preferredWorkspaceId(userId: string): Promise<string | null> {
    if (!userId) return null;
    return this.firstWorkspaceId(userId);
  }

  private async userEmail(userId: string): Promise<string | null> {
    // `auth.users` is not readable from the app schema in a hosted project, and the desktop only
    // needs enough to label the signed-in account. A missing row is not an error.
    try {
      const res = await this.db.query<{ email: string | null }>(
        `select email from auth.users where id = $1`,
        [userId],
      );
      return res.rows[0]?.email ?? null;
    } catch {
      return null;
    }
  }

  private async sessionExpiry(rawToken: string | null | undefined): Promise<string> {
    if (!rawToken) return new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const res = await this.db.query<{ expires_at: unknown }>(
      `select expires_at from public.desktop_sessions where token_hash = $1`,
      [sha256Hex(rawToken)],
    );
    const row = res.rows[0];
    return row ? toIso(row.expires_at) : new Date().toISOString();
  }
}

function requireUserId(auth: AuthenticatedPrincipal | null | undefined): string {
  if (!auth || typeof auth.userId !== 'string' || !auth.userId) {
    throw new Phase4ServiceError(
      401,
      'unauthenticated',
      'This desktop session is no longer valid. Sign in again.',
    );
  }
  return auth.userId;
}

function safeIso(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * `Suhbat — 8 Oct, 14:32`.
 *
 * Server-side and therefore UTC unless the client supplies a start instant; the desktop sends its
 * own local-start-derived title when it can, so the label matches what the user saw on the button.
 */
export function defaultMeetingTitle(startedAt?: string, now = new Date()): string {
  const at = startedAt ? new Date(startedAt) : now;
  const instant = Number.isNaN(at.getTime()) ? now : at;
  const day = instant.getUTCDate();
  const month = MONTH_LABELS[instant.getUTCMonth()] ?? 'Jan';
  const hours = String(instant.getUTCHours()).padStart(2, '0');
  const minutes = String(instant.getUTCMinutes()).padStart(2, '0');
  return `Suhbat — ${day} ${month}, ${hours}:${minutes}`;
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
] as const;

export const DESKTOP_CONNECT_CODE_TTL_MS = CONNECT_CODE_TTL_MS;
export const DESKTOP_SESSION_TTL_MS = SESSION_TTL_MS;
export const DESKTOP_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
