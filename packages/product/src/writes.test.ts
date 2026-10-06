import { describe, expect, it } from 'vitest';
import { WriteValidationError, parseWriteInput, toIdList, toBoolean, toIsoInstant } from './writes';
import {
  companyCreateInputSchema,
  meetingDraftCreateInputSchema,
  meetingTypeCreateInputSchema,
  memberInviteInputSchema,
  projectCreateInputSchema,
  vocabularyCreateInputSchema,
} from './writes';

/**
 * Write inputs are validated once, here, so that a browser form, a future API client and a test cannot each
 * invent their own idea of a valid company name. These assertions are about the rules the product promises.
 */

describe('write input rules', () => {
  it('trims text and rejects a name that is only whitespace', () => {
    const parsed = companyCreateInputSchema.safeParse({
      workspaceId: 'ws_1',
      name: '  Nudge Studio  ',
      description: '',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Nudge Studio');
      // An empty textarea means "no description", not a one-character string.
      expect(parsed.data.description).toBeNull();
    }
    expect(companyCreateInputSchema.safeParse({ workspaceId: 'ws_1', name: '   ' }).success).toBe(
      false,
    );
  });

  it('holds the same length limits as the Supabase-facing contracts', () => {
    expect(companyCreateInputSchema.safeParse({ workspaceId: 'w', name: 'a' }).success).toBe(false);
    expect(
      companyCreateInputSchema.safeParse({ workspaceId: 'w', name: 'a'.repeat(121) }).success,
    ).toBe(false);
    expect(
      meetingDraftCreateInputSchema.safeParse({
        workspaceId: 'w',
        title: 't'.repeat(181),
        meetingTypeId: 'mt_1',
      }).success,
    ).toBe(false);
    expect(
      companyCreateInputSchema.safeParse({
        workspaceId: 'w',
        name: 'N',
        description: 'd'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  it('treats an empty relation select as null rather than an empty id', () => {
    const parsed = projectCreateInputSchema.safeParse({
      workspaceId: 'ws_1',
      name: 'Renewal motion',
      companyId: '',
      description: undefined,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.companyId).toBeNull();
    // An id must be an id; a stray placeholder must not be written to a relation column.
    expect(
      projectCreateInputSchema.safeParse({
        workspaceId: 'ws_1',
        name: 'Renewal motion',
        companyId: 'none',
      }).success,
    ).toBe(true);
    expect(
      projectCreateInputSchema.safeParse({
        workspaceId: 'ws_1',
        name: 'Renewal motion',
        companyId: 'a'.repeat(121),
      }).success,
    ).toBe(false);
  });

  it('requires a meeting type and a title for a draft, and defaults the rest', () => {
    const parsed = meetingDraftCreateInputSchema.parse({
      workspaceId: 'ws_1',
      title: 'Renewal conversation prep',
      meetingTypeId: 'mt_2',
    });
    expect(parsed.participantIds).toEqual([]);
    expect(parsed.notes).toBeNull();
    expect(parsed.durationMinutes).toBeUndefined();
  });

  it('accepts only a slug-shaped meeting type key', () => {
    expect(
      meetingTypeCreateInputSchema.safeParse({
        workspaceId: 'ws_1',
        key: 'customer_call',
        displayName: 'Customer call',
      }).success,
    ).toBe(true);
    for (const key of ['Customer Call', '1call', 'a', 'lead-call', 'x'.repeat(40)])
      expect(
        meetingTypeCreateInputSchema.safeParse({
          workspaceId: 'ws_1',
          key,
          displayName: 'Customer call',
        }).success,
        key,
      ).toBe(false);
  });

  it('normalizes an invitation address and defaults the role to member', () => {
    const parsed = memberInviteInputSchema.parse({
      workspaceId: 'ws_1',
      email: '  Advisor@Example.COM ',
    });
    expect(parsed.email).toBe('advisor@example.com');
    expect(parsed.role).toBe('member');
    for (const email of ['', 'nope', 'a@b', 'two @@ example.com'])
      expect(memberInviteInputSchema.safeParse({ workspaceId: 'ws_1', email }).success, email).toBe(
        false,
      );
  });

  it('requires the scope to carry the record it names', () => {
    const base = { workspaceId: 'ws_1', term: 'Suhbat', scope: 'company' as const };
    expect(vocabularyCreateInputSchema.safeParse(base).success).toBe(false);
    const parsed = vocabularyCreateInputSchema.safeParse({ ...base, companyId: 'company_1' });
    expect(parsed.success).toBe(true);
    expect(
      vocabularyCreateInputSchema.safeParse({
        workspaceId: 'ws_1',
        term: 'Suhbat',
        scope: 'meeting',
      }).success,
    ).toBe(false);
  });

  it('reports the field that failed, so a form can put the message on it', () => {
    try {
      parseWriteInput(companyCreateInputSchema, { workspaceId: 'ws_1', name: 'x' });
      throw new Error('expected the parse to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WriteValidationError);
      const failure = error as WriteValidationError;
      expect(failure.fields[0]).toMatch(/^name: /);
      expect(failure.message).toContain('name');
    }
  });
});

describe('form value helpers', () => {
  it('canonicalizes the date shapes a form can produce', () => {
    expect(toIsoInstant('2026-10-09', 'fallback')).toBe('2026-10-09T09:00:00.000Z');
    expect(toIsoInstant('2026-10-09T14:30', 'fallback')).toBe('2026-10-09T14:30:00.000Z');
    expect(toIsoInstant('not a day', 'fallback')).toBe('fallback');
    expect(toIsoInstant(undefined, 'fallback')).toBe('fallback');
  });

  it('reads checkboxes and hidden inputs as booleans', () => {
    expect(toBoolean('on', false)).toBe(true);
    expect(toBoolean('off', true)).toBe(false);
    expect(toBoolean(undefined, true)).toBe(true);
    expect(toBoolean('', true)).toBe(true);
    expect(toBoolean(false, true)).toBe(false);
  });

  it('de-duplicates and cleans a multi-select', () => {
    expect(toIdList(['person_a', ' person_a ', '', 'person_b'])).toEqual(['person_a', 'person_b']);
    expect(toIdList('person_a')).toEqual(['person_a']);
    expect(toIdList(undefined)).toEqual([]);
    expect(toIdList([])).toEqual([]);
  });
});
