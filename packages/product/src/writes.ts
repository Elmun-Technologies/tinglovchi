import { z } from 'zod';
import { idSchema } from './domain';
import { RepositoryError } from './repositories';

/**
 * Write-side contracts: the shapes every create/update/archive flow accepts, and the rules it must satisfy.
 *
 * Why they live here rather than in a form component: the same rules must reject the same input whether the
 * request came from a browser form, a future API client, or a test. Text limits deliberately mirror
 * `@suhbat/contracts` (company/project name 2–120, meeting title 2–180, description ≤1000) so a live adapter
 * and the demo adapter cannot drift into disagreeing about validity. Ids stay opaque (`idSchema`) here, unlike
 * the Supabase-facing contracts, because the product layer must not assume a UUID shape.
 *
 * Every schema turns `''` into `null` for optional relations and trims text, so "cleared the field" and "left
 * it empty" arrive as the same, well-defined value instead of a string of whitespace.
 */

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
/** A form sends `''` for a cleared textarea; a programmatic caller sends `null`. Both mean "no value". */
const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((value) => (value ? value : null));
/**
 * In an update, absence and emptiness are different instructions: a field that is not in the payload is left
 * alone, while `''` or `null` clears it. Toggling one flag must not have to resend the others.
 */
const patchText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional();
// Optional so a caller may omit a relation entirely; `''` is what an unselected `<select>` submits.
const nullableId = z
  .union([z.literal(''), z.null(), idSchema])
  .optional()
  .transform((value) => (value ? value : null));

export const companyCreateInputSchema = z.object({
  workspaceId: idSchema,
  name: trimmed(2, 120),
  description: optionalText(1000),
});
export type CompanyCreateInput = z.infer<typeof companyCreateInputSchema>;

export const companyUpdateInputSchema = z.object({
  name: trimmed(2, 120),
  description: optionalText(1000),
});
export type CompanyUpdateInput = z.infer<typeof companyUpdateInputSchema>;

export const projectCreateInputSchema = z.object({
  workspaceId: idSchema,
  name: trimmed(2, 120),
  companyId: nullableId,
  description: optionalText(1000),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

export const projectUpdateInputSchema = z.object({
  name: trimmed(2, 120),
  companyId: nullableId,
  description: optionalText(1000),
  /** Lifecycle is set from the project page, not from free text. */
  status: z.enum(['active', 'paused', 'closed']).optional(),
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInputSchema>;

/**
 * A meeting draft is a placeholder for a recording that has not happened. Nothing here may imply that audio
 * was captured: `occurredAt` is the scheduled time, and participants are only names the recorder will later
 * map its diarization labels onto.
 */
export const meetingDraftCreateInputSchema = z.object({
  workspaceId: idSchema,
  title: trimmed(2, 180),
  meetingTypeId: idSchema,
  companyId: nullableId,
  projectId: nullableId,
  participantIds: z.array(idSchema).max(24).default([]),
  occurredAt: z.string().trim().optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
  /** What the recorder wants to get out of the meeting; free text, never an insight. */
  notes: optionalText(2000),
});
export type MeetingDraftCreateInput = z.infer<typeof meetingDraftCreateInputSchema>;

export const meetingDraftUpdateInputSchema = z.object({
  title: trimmed(2, 180),
  meetingTypeId: idSchema,
  companyId: nullableId,
  projectId: nullableId,
  participantIds: z.array(idSchema).max(24).default([]),
  occurredAt: z.string().trim().optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .optional(),
  notes: optionalText(2000),
});
export type MeetingDraftUpdateInput = z.infer<typeof meetingDraftUpdateInputSchema>;

/** A meeting type key is a slug: it is what the future pipeline will look prompts up by. */
export const meetingTypeKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,31}$/, 'Use a lowercase key such as `customer_call`.');

export const meetingTypeCreateInputSchema = z.object({
  workspaceId: idSchema,
  key: meetingTypeKeySchema,
  displayName: trimmed(2, 60),
});
export type MeetingTypeCreateInput = z.infer<typeof meetingTypeCreateInputSchema>;

export const meetingTypeUpdateInputSchema = z.object({
  displayName: trimmed(2, 60).optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});
export type MeetingTypeUpdateInput = z.infer<typeof meetingTypeUpdateInputSchema>;

/**
 * Vocabulary terms steer a future transcription step. `context` is the pronunciation/usage note; `scope`
 * decides how widely the term applies, and a company scope requires the company.
 */
export const vocabularyScopeSchema = z.enum(['workspace', 'company', 'meeting']);
export type VocabularyScope = z.infer<typeof vocabularyScopeSchema>;

export const vocabularyCreateInputSchema = z
  .object({
    workspaceId: idSchema,
    term: trimmed(2, 120),
    context: optionalText(200),
    scope: vocabularyScopeSchema.default('workspace'),
    companyId: nullableId,
    meetingId: nullableId,
    enabled: z.boolean().default(true),
  })
  .refine((value) => value.scope !== 'company' || value.companyId !== null, {
    message: 'A company-scoped term needs a company.',
    path: ['companyId'],
  })
  .refine((value) => value.scope !== 'meeting' || value.meetingId !== null, {
    message: 'A meeting-scoped term needs a meeting.',
    path: ['meetingId'],
  });
export type VocabularyCreateInput = z.infer<typeof vocabularyCreateInputSchema>;

export const vocabularyUpdateInputSchema = z.object({
  term: trimmed(2, 120).optional(),
  context: patchText(200),
  enabled: z.boolean().optional(),
});
export type VocabularyUpdateInput = z.infer<typeof vocabularyUpdateInputSchema>;

export const workspaceRenameInputSchema = z.object({
  workspaceId: idSchema,
  name: trimmed(2, 80),
});
export type WorkspaceRenameInput = z.infer<typeof workspaceRenameInputSchema>;

/**
 * An invitation carries an email and a role, nothing else. Delivery is a server concern: an adapter that
 * cannot send mail records the invitation as `invited` and says so — the product must not imply a mail went out.
 */
export const memberInviteInputSchema = z.object({
  workspaceId: idSchema,
  email: z
    .string()
    .trim()
    .email('A valid email address is required.')
    .transform((value) => value.toLowerCase()),
  role: z.enum(['admin', 'member']).default('member'),
});
export type MemberInviteInput = z.infer<typeof memberInviteInputSchema>;

export const memberRoleUpdateInputSchema = z.object({
  workspaceId: idSchema,
  personId: idSchema,
  role: z.enum(['owner', 'admin', 'member']),
});
export type MemberRoleUpdateInput = z.infer<typeof memberRoleUpdateInputSchema>;

export const memberRemoveInputSchema = z.object({
  workspaceId: idSchema,
  personId: idSchema,
});
export type MemberRemoveInput = z.infer<typeof memberRemoveInputSchema>;

/**
 * The speaker-mapping persistence contract: one diarization label in one meeting, assigned to one person.
 *
 * It is intentionally narrow. There is no voiceprint, no cross-meeting identity, no "apply to all meetings" —
 * those would need an identity system, and inventing one here would be a claim the data cannot support.
 */
export const speakerMappingCommitSchema = z.object({
  meetingId: idSchema,
  label: trimmed(1, 40),
  personId: idSchema,
});
export type SpeakerMappingCommit = z.infer<typeof speakerMappingCommitSchema>;

/**
 * Reads that scope a browse. Archived records exist and must stay reachable, but not by default; the facets are
 * here rather than in a page so the list, its counts and its "N of M" line cannot disagree with each other.
 */
export const entityListFilterSchema = z.object({
  includeArchived: z.boolean().default(false),
  query: z.string().trim().default(''),
  /** Project lists can be scoped by company; a company list ignores it. */
  companyId: z.string().trim().optional(),
  /** `active | paused | closed` for a project, `active | archived` for a company. */
  status: z.string().trim().optional(),
});
export type EntityListFilter = z.input<typeof entityListFilterSchema>;

/** Normalizes form data into an input object; throws `validation_failed` with per-field messages. */
export function parseWriteInput<S extends z.ZodTypeAny>(
  schema: S,
  raw: Record<string, unknown>,
): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new WriteValidationError(
      first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`),
    );
  }
  return parsed.data as z.infer<S>;
}

export class WriteValidationError extends RepositoryError {
  readonly fields: string[];
  constructor(message: string, fields: string[] = []) {
    super('validation_failed', message, { detail: fields[0] });
    this.name = 'WriteValidationError';
    this.fields = fields;
  }
}

/**
 * `datetime-local` values and bare dates both arrive as strings; records store canonical ISO instants.
 *
 * A value with no offset is read as UTC rather than as the server's local time. That is deliberate: the same
 * draft must land on the same instant whether it was typed in Tashkent or reviewed in CI, and a demo has no
 * per-user timezone to consult. A live adapter will take an explicit zone from the workspace instead.
 */
export function toIsoInstant(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const text = value.trim();
  const candidate = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text)
    ? text
    : `${text.includes('T') ? text : `${text}T09:00:00`}Z`;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function toBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(text)) return true;
  if (['0', 'false', 'off', 'no'].includes(text)) return false;
  return fallback;
}

/** Multi-select fields arrive as repeated values; checkbox groups as one key per checked box. */
export function toIdList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      list
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0),
    ),
  ];
}
