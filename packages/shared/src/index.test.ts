import { describe, expect, it } from 'vitest';
import { isValidWorkspaceSlug, toWorkspaceSlug } from './index';

describe('workspace slugs', () => {
  it('normalizes names without retaining punctuation or spaces', () => {
    expect(toWorkspaceSlug('Elmurod & Company')).toBe('elmurod-company');
  });

  it('keeps a bounded ASCII slug for Uzbek names', () => {
    expect(toWorkspaceSlug('Oʻzbekiston marketing jamoasi')).toMatch(/^[a-z0-9-]+$/);
    expect(toWorkspaceSlug('Oʻzbekiston marketing jamoasi').length).toBeLessThanOrEqual(48);
  });

  it('uses a safe fallback if a name contains no ASCII slug characters', () => {
    expect(toWorkspaceSlug('東京')).toBe('workspace');
  });

  it('validates the slug format expected by PostgreSQL', () => {
    expect(isValidWorkspaceSlug('elmurod-company')).toBe(true);
    expect(isValidWorkspaceSlug('-bad-')).toBe(false);
    expect(isValidWorkspaceSlug('UPPER')).toBe(false);
  });
});
