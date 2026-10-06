import { describe, expect, it } from 'vitest';
import { createMeetingInputSchema, createWorkspaceInputSchema } from './index';

describe('Phase 1 input contracts', () => {
  it('trims and validates a workspace name', () => {
    expect(createWorkspaceInputSchema.parse({ name: '  Acme  ' })).toEqual({ name: 'Acme' });
    expect(createWorkspaceInputSchema.safeParse({ name: ' ' }).success).toBe(false);
  });

  it('accepts optional meeting context only as UUIDs or empty values', () => {
    const input = createMeetingInputSchema.safeParse({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      title: 'Quarterly planning',
      meetingTypeId: '22222222-2222-4222-8222-222222222222',
      companyId: '',
      projectId: '',
    });
    expect(input.success).toBe(true);
    if (input.success) {
      expect(input.data.companyId).toBeNull();
      expect(input.data.projectId).toBeNull();
    }
  });

  it('rejects malformed workspace and relation IDs before database access', () => {
    expect(
      createMeetingInputSchema.safeParse({
        workspaceId: 'not-a-uuid',
        title: 'Planning',
        meetingTypeId: '22222222-2222-4222-8222-222222222222',
        companyId: '',
        projectId: '',
      }).success,
    ).toBe(false);
  });
});
