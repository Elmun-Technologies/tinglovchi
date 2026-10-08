import { z } from 'zod';
import { RESOURCE_ID_SCHEMA_PATTERN, countSchema } from './recorder';

/**
 * Desktop client contracts (One-Tap Recorder Mode).
 *
 * These are the only shapes the SUHBAT desktop app may exchange with the server. Three rules:
 *
 * 1. **The renderer never sees a provider credential.** A desktop session token is an opaque
 *    server-issued bearer string; the desktop stores it and sends it back. There is no Supabase
 *    service-role key, no object-storage secret, and no OpenAI/AssemblyAI key in any field below.
 * 2. **Meeting creation never blocks capture.** Every field a user could reasonably not know yet
 *    (title, meeting type, company, project) is optional, and the server fills a defensible default.
 * 3. **Processing state is observed, never invented.** The desktop polls the canonical
 *    `MeetingProcessingResponse` produced by the existing pipeline; it renders whatever that says.
 */

const uuidSchema = () => z.string().regex(RESOURCE_ID_SCHEMA_PATTERN, 'expected a lowercase UUID');

/** Opaque, server-generated, single-use. Shown to the user once; only its SHA-256 is stored. */
export const desktopConnectCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/, 'expected a connect code like AB12-CDEF-GH34');

export const desktopConnectCodeStatusSchema = z.enum([
  'pending',
  'authorized',
  'consumed',
  'expired',
]);
export type DesktopConnectCodeStatus = z.infer<typeof desktopConnectCodeStatusSchema>;

/** `POST /api/v1/desktop/connect-codes`. Unauthenticated by design (device-flow shaped). */
export const createDesktopConnectCodeRequestSchema = z
  .object({
    /** Short, non-PII label such as the OS + app version, for the user's own confirmation screen. */
    clientLabel: z.string().trim().max(80).optional(),
  })
  .default({});
export type CreateDesktopConnectCodeRequestInput = z.input<
  typeof createDesktopConnectCodeRequestSchema
>;

export const desktopConnectCodeResponseSchema = z.object({
  code: desktopConnectCodeSchema,
  status: desktopConnectCodeStatusSchema,
  expiresAt: z.string().min(1),
  /** Milliseconds the desktop should wait between exchange attempts. */
  pollIntervalMs: countSchema,
});
export type DesktopConnectCodeResponse = z.infer<typeof desktopConnectCodeResponseSchema>;

/** `POST /api/v1/desktop/sessions` — exchange an authorized code for a bearer session. */
export const exchangeDesktopSessionRequestSchema = z.object({
  code: desktopConnectCodeSchema,
  /** Non-PII label for the session list the user can revoke from the web dashboard. */
  clientLabel: z.string().trim().max(80).optional(),
});
export type ExchangeDesktopSessionRequestInput = z.input<
  typeof exchangeDesktopSessionRequestSchema
>;

export const workspaceSummaryDtoSchema = z.object({
  id: uuidSchema(),
  name: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member']),
  /** The workspace's own default meeting type (lowest active sort order). Null only if none exist. */
  defaultMeetingTypeId: uuidSchema().nullable(),
  defaultMeetingTypeLabel: z.string().min(1).nullable(),
  meetingTypeCount: countSchema,
});
export type WorkspaceSummaryDto = z.infer<typeof workspaceSummaryDtoSchema>;

/**
 * `GET /api/v1/workspaces` — the picker the recorder shows when the user belongs to more than one.
 *
 * Deliberately the same DTO as the session response, so the switcher and the boot flow cannot drift.
 */
export const desktopWorkspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSummaryDtoSchema),
});
export type DesktopWorkspaceListResponse = z.infer<typeof desktopWorkspaceListResponseSchema>;

export const desktopSessionResponseSchema = z.object({
  /** Opaque bearer token. Returned exactly once; only its SHA-256 is stored server-side. */
  token: z.string().min(32).max(512),
  userId: uuidSchema(),
  userEmail: z.string().min(3).nullable(),
  /** The workspace the recorder should preselect: last-used, else the only one, else null. */
  defaultWorkspaceId: uuidSchema().nullable(),
  workspaces: z.array(workspaceSummaryDtoSchema),
  expiresAt: z.string().min(1),
});
export type DesktopSessionResponse = z.infer<typeof desktopSessionResponseSchema>;

/** `GET /api/v1/desktop/session`. */
export const desktopSessionInfoResponseSchema = z.object({
  userId: uuidSchema(),
  userEmail: z.string().min(3).nullable(),
  defaultWorkspaceId: uuidSchema().nullable(),
  workspaces: z.array(workspaceSummaryDtoSchema),
  expiresAt: z.string().min(1),
});
export type DesktopSessionInfoResponse = z.infer<typeof desktopSessionInfoResponseSchema>;

export const revokeDesktopSessionResponseSchema = z.object({
  revoked: z.literal(true),
});
export type RevokeDesktopSessionResponse = z.infer<typeof revokeDesktopSessionResponseSchema>;

/**
 * `POST /api/v1/meetings` — automatic meeting context for one-tap recording.
 *
 * Only `workspaceId` is required. Everything else has a server-side default so a recording is
 * never blocked by a form the user did not want to fill in.
 */
export const createMeetingRequestSchema = z.object({
  workspaceId: uuidSchema(),
  /** Generated by the desktop from the local start time, e.g. `Suhbat — 8 Oct, 14:32`. */
  title: z.string().trim().min(2).max(180).optional(),
  meetingTypeId: uuidSchema().optional(),
  companyId: uuidSchema().nullable().optional(),
  projectId: uuidSchema().nullable().optional(),
  /** Set by the desktop so it can be found and re-linked later; never shown as user content. */
  source: z.literal('desktop_recorder').default('desktop_recorder'),
  /** ISO instant the button was pressed, used for `started_at` when the meeting is created late. */
  startedAt: z.string().min(1).optional(),
});
export type CreateMeetingRequestInput = z.input<typeof createMeetingRequestSchema>;

export const meetingDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  title: z.string().min(1),
  status: z.string().min(1),
  meetingTypeId: uuidSchema(),
  meetingTypeLabel: z.string().min(1),
  companyId: uuidSchema().nullable(),
  projectId: uuidSchema().nullable(),
  createdBy: uuidSchema(),
  startedAt: z.string().min(1),
  createdAt: z.string().min(1),
});
export type MeetingDto = z.infer<typeof meetingDtoSchema>;

export const createMeetingResponseSchema = z.object({
  meeting: meetingDtoSchema,
  /** True when the meeting type/title were defaulted rather than supplied by the client. */
  defaultsApplied: z.object({
    title: z.boolean(),
    meetingType: z.boolean(),
  }),
});
export type CreateMeetingResponse = z.infer<typeof createMeetingResponseSchema>;

/**
 * Wire errors for the desktop client. The desktop maps these onto plain language, so `code` is a
 * stable machine value while `message` is operator-facing English and never shown verbatim in the UI.
 */
export const DESKTOP_API_ERROR_CODES = [
  'unauthenticated',
  'unauthorized',
  'not_found',
  'validation_failed',
  'invalid_state',
  'rate_limited',
  'offline',
  'network_error',
  'timeout',
  'server_error',
  'contract_violation',
  'not_configured',
] as const;

export const desktopApiErrorCodeSchema = z.enum(DESKTOP_API_ERROR_CODES);
export type DesktopApiErrorCode = z.infer<typeof desktopApiErrorCodeSchema>;
