import { z } from 'zod';

const uuidSchema = () =>
  z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'expected a lowercase UUID',
    );

export const automationConnectorTypeSchema = z.enum([
  'webhook_n8n',
  'amocrm',
  'google_docs',
  'google_calendar',
  'meeting_export',
]);
export type AutomationConnectorType = z.infer<typeof automationConnectorTypeSchema>;

export const automationConnectorStatusSchema = z.enum(['active', 'disabled']);
export type AutomationConnectorStatus = z.infer<typeof automationConnectorStatusSchema>;

export const automationActionTypeSchema = z.enum([
  'export_meeting_report',
  'sync_crm_summary',
  'sync_crm_tasks',
  'publish_google_doc',
  'schedule_calendar_followup',
  'trigger_n8n_workflow',
]);
export type AutomationActionType = z.infer<typeof automationActionTypeSchema>;

export const automationActionStatusSchema = z.enum([
  'pending_confirmation',
  'confirmed',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
]);
export type AutomationActionStatus = z.infer<typeof automationActionStatusSchema>;

export const meetingExportFormatSchema = z.enum(['md', 'txt', 'csv', 'json']);
export type MeetingExportFormat = z.infer<typeof meetingExportFormatSchema>;

export const workspaceAutomationConnectorDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  connectorType: automationConnectorTypeSchema,
  label: z.string().min(1).max(120),
  status: automationConnectorStatusSchema,
  endpointUrl: z.string().url().nullable(),
  configMetadata: z.record(z.string(), z.unknown()),
  createdBy: uuidSchema(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WorkspaceAutomationConnectorDto = z.infer<typeof workspaceAutomationConnectorDtoSchema>;

export const upsertWorkspaceConnectorRequestSchema = z.object({
  connectorType: automationConnectorTypeSchema,
  label: z.string().trim().min(1).max(120),
  status: automationConnectorStatusSchema.default('active'),
  endpointUrl: z.string().url().nullable().optional(),
  configMetadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpsertWorkspaceConnectorRequestInput = z.input<
  typeof upsertWorkspaceConnectorRequestSchema
>;

export const listWorkspaceConnectorsResponseSchema = z.object({
  workspaceId: uuidSchema(),
  connectors: z.array(workspaceAutomationConnectorDtoSchema),
});
export type ListWorkspaceConnectorsResponse = z.infer<typeof listWorkspaceConnectorsResponseSchema>;

export const automationPayloadEvidenceItemSchema = z.object({
  segmentId: uuidSchema(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  quoteText: z.string().min(1),
  deepLinkUrl: z.string().url(),
});
export type AutomationPayloadEvidenceItem = z.infer<typeof automationPayloadEvidenceItemSchema>;

export const automationPayloadPreviewSchema = z.object({
  meetingId: uuidSchema(),
  workspaceId: uuidSchema(),
  analysisRunId: uuidSchema(),
  meetingTitle: z.string().min(1),
  companyName: z.string().nullable(),
  projectName: z.string().nullable(),
  connectorType: automationConnectorTypeSchema,
  actionType: automationActionTypeSchema,
  summaryHeadline: z.string().nullable(),
  summaryTlDr: z.string().nullable(),
  confirmedDecisions: z.array(
    z.object({
      id: uuidSchema(),
      title: z.string().min(1),
      statement: z.string().min(1),
      segmentIds: z.array(uuidSchema()),
    }),
  ),
  openTasks: z.array(
    z.object({
      id: uuidSchema(),
      title: z.string().min(1),
      ownerLabel: z.string().nullable(),
      dueDate: z.string().nullable(),
      segmentIds: z.array(uuidSchema()),
    }),
  ),
  evidence: z.array(automationPayloadEvidenceItemSchema),
  meetingOverviewUrl: z.string().url(),
});
export type AutomationPayloadPreview = z.infer<typeof automationPayloadPreviewSchema>;

export const businessAutomationActionDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema(),
  connectorId: uuidSchema().nullable(),
  connectorType: automationConnectorTypeSchema,
  actionType: automationActionTypeSchema,
  status: automationActionStatusSchema,
  idempotencyKey: z.string().min(8).max(200),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  payloadPreview: automationPayloadPreviewSchema,
  evidenceSegmentIds: z.array(uuidSchema()),
  requestedBy: uuidSchema(),
  confirmedBy: uuidSchema().nullable(),
  confirmedAt: z.string().datetime().nullable(),
  executedAt: z.string().datetime().nullable(),
  attemptCount: z.number().int().nonnegative(),
  externalReferenceId: z.string().nullable(),
  externalUrl: z.string().url().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BusinessAutomationActionDto = z.infer<typeof businessAutomationActionDtoSchema>;

export const prepareAutomationActionRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  connectorType: automationConnectorTypeSchema,
  actionType: automationActionTypeSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
  selectedDecisionIds: z.array(uuidSchema()).optional(),
  selectedTaskIds: z.array(uuidSchema()).optional(),
});
export type PrepareAutomationActionRequestInput = z.input<
  typeof prepareAutomationActionRequestSchema
>;

export const prepareAutomationActionResponseSchema = z.object({
  action: businessAutomationActionDtoSchema,
  confirmationToken: z.string().min(16).max(200).nullable(),
  idempotentReused: z.boolean(),
});
export type PrepareAutomationActionResponse = z.infer<typeof prepareAutomationActionResponseSchema>;

export const confirmAutomationActionRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  confirmed: z.literal(true, {
    message:
      'Explicit user confirmation (confirmed: true) is required for outbound business actions.',
  }),
  confirmationToken: z.string().trim().min(16).max(200),
  executeImmediately: z.boolean().default(true),
});
export type ConfirmAutomationActionRequestInput = z.input<
  typeof confirmAutomationActionRequestSchema
>;

export const confirmAutomationActionResponseSchema = z.object({
  action: businessAutomationActionDtoSchema,
  idempotentReused: z.boolean(),
});
export type ConfirmAutomationActionResponse = z.infer<typeof confirmAutomationActionResponseSchema>;

export const meetingExportRecordDtoSchema = z.object({
  id: uuidSchema(),
  workspaceId: uuidSchema(),
  meetingId: uuidSchema(),
  analysisRunId: uuidSchema().nullable(),
  exportFormat: meetingExportFormatSchema,
  includeTranscript: z.boolean(),
  filename: z.string().min(1).max(200),
  byteSize: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  exportedBy: uuidSchema(),
  createdAt: z.string().datetime(),
});
export type MeetingExportRecordDto = z.infer<typeof meetingExportRecordDtoSchema>;

export const createMeetingExportRequestSchema = z.object({
  workspaceId: uuidSchema().optional(),
  format: meetingExportFormatSchema.default('md'),
  includeTranscript: z.boolean().default(false),
});
export type CreateMeetingExportRequestInput = z.input<typeof createMeetingExportRequestSchema>;

export const createMeetingExportResponseSchema = z.object({
  exportRecord: meetingExportRecordDtoSchema,
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  content: z.string(),
});
export type CreateMeetingExportResponse = z.infer<typeof createMeetingExportResponseSchema>;

export const listMeetingAutomationsResponseSchema = z.object({
  meetingId: uuidSchema(),
  workspaceId: uuidSchema(),
  actions: z.array(businessAutomationActionDtoSchema),
  exports: z.array(meetingExportRecordDtoSchema),
});
export type ListMeetingAutomationsResponse = z.infer<typeof listMeetingAutomationsResponseSchema>;
