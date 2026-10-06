import { z } from 'zod';

export * from './recorder';

export const workspaceIdSchema = z.string().uuid();
export const resourceIdSchema = z.string().uuid();

export const workspaceNameSchema = z.string().trim().min(2).max(80);
export const companyNameSchema = z.string().trim().min(2).max(120);
export const projectNameSchema = z.string().trim().min(2).max(120);
export const meetingTitleSchema = z.string().trim().min(2).max(180);
export const descriptionSchema = z.string().trim().max(1000);

export const createWorkspaceInputSchema = z.object({
  name: workspaceNameSchema,
});

export const createCompanyInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  name: companyNameSchema,
  description: descriptionSchema.optional().transform((value) => value || null),
});

export const createProjectInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  name: projectNameSchema,
  companyId: z.union([z.literal(''), resourceIdSchema]).transform((value) => value || null),
  description: descriptionSchema.optional().transform((value) => value || null),
});

export const createMeetingInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: meetingTitleSchema,
  meetingTypeId: resourceIdSchema,
  companyId: z.union([z.literal(''), resourceIdSchema]).transform((value) => value || null),
  projectId: z.union([z.literal(''), resourceIdSchema]).transform((value) => value || null),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;
export type CreateCompanyInput = z.infer<typeof createCompanyInputSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateMeetingInput = z.infer<typeof createMeetingInputSchema>;
