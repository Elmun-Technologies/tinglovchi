import { randomBytes } from 'node:crypto';
import {
  confirmAutomationActionRequestSchema,
  createMeetingExportRequestSchema,
  prepareAutomationActionRequestSchema,
  upsertWorkspaceConnectorRequestSchema,
  type AutomationActionStatus,
  type AutomationActionType,
  type AutomationConnectorStatus,
  type AutomationConnectorType,
  type AutomationPayloadEvidenceItem,
  type AutomationPayloadPreview,
  type BusinessAutomationActionDto,
  type ConfirmAutomationActionRequestInput,
  type ConfirmAutomationActionResponse,
  type CreateMeetingExportRequestInput,
  type CreateMeetingExportResponse,
  type ListMeetingAutomationsResponse,
  type ListWorkspaceConnectorsResponse,
  type MeetingExportFormat,
  type MeetingExportRecordDto,
  type PrepareAutomationActionRequestInput,
  type PrepareAutomationActionResponse,
  type ProcessingJobDto,
  type UpsertWorkspaceConnectorRequestInput,
  type WorkspaceAutomationConnectorDto,
} from '@suhbat/contracts';
import { AutomationProviderError, type BusinessAutomationProvider } from './automation-provider';
import { getCanonicalAppUrl } from './config';
import {
  Phase4ServiceError,
  type AuthenticatedPrincipal,
  type ClaimJobOptions,
  type SqlExecutor,
  type StructuredObservabilityEvent,
} from './phase4-backbone';
import { Phase8TelegramService, Phase8TelegramWorker } from './phase8-telegram';
import { computeSha256Hex } from './storage';

type DbWorkspaceConnectorRow = {
  id: string;
  workspace_id: string;
  connector_type: AutomationConnectorType;
  label: string;
  status: AutomationConnectorStatus;
  endpoint_url: string | null;
  config_metadata: Record<string, unknown> | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type DbBusinessAutomationActionRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string;
  connector_id: string | null;
  connector_type: AutomationConnectorType;
  action_type: AutomationActionType;
  status: AutomationActionStatus;
  idempotency_key: string;
  confirmation_token_sha256: string;
  payload_sha256: string;
  payload_preview: AutomationPayloadPreview;
  evidence_segment_ids: string[] | null;
  requested_by: string;
  confirmed_by: string | null;
  confirmed_at: string | Date | null;
  executed_at: string | Date | null;
  attempt_count: number;
  external_reference_id: string | null;
  external_url: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type DbMeetingExportRow = {
  id: string;
  workspace_id: string;
  meeting_id: string;
  analysis_run_id: string | null;
  export_format: MeetingExportFormat;
  include_transcript: boolean;
  filename: string;
  byte_size: number;
  content_sha256: string;
  exported_by: string;
  created_at: string | Date;
};

function toIsoString(val: string | Date): string {
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? String(val) : parsed.toISOString();
}

function toNullableIsoString(val: string | Date | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  return toIsoString(val);
}

function mapConnectorRow(row: DbWorkspaceConnectorRow): WorkspaceAutomationConnectorDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectorType: row.connector_type,
    label: row.label,
    status: row.status,
    endpointUrl: row.endpoint_url,
    configMetadata: row.config_metadata ?? {},
    createdBy: row.created_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapActionRow(row: DbBusinessAutomationActionRow): BusinessAutomationActionDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    analysisRunId: row.analysis_run_id,
    connectorId: row.connector_id,
    connectorType: row.connector_type,
    actionType: row.action_type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    payloadSha256: row.payload_sha256,
    payloadPreview: row.payload_preview,
    evidenceSegmentIds: row.evidence_segment_ids ?? [],
    requestedBy: row.requested_by,
    confirmedBy: row.confirmed_by,
    confirmedAt: toNullableIsoString(row.confirmed_at),
    executedAt: toNullableIsoString(row.executed_at),
    attemptCount: Number(row.attempt_count),
    externalReferenceId: row.external_reference_id,
    externalUrl: row.external_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapExportRow(row: DbMeetingExportRow): MeetingExportRecordDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    analysisRunId: row.analysis_run_id,
    exportFormat: row.export_format,
    includeTranscript: row.include_transcript,
    filename: row.filename,
    byteSize: Number(row.byte_size),
    contentSha256: row.content_sha256,
    exportedBy: row.exported_by,
    createdAt: toIsoString(row.created_at),
  };
}

function computeTextSha256(text: string): string {
  return computeSha256Hex(new TextEncoder().encode(text));
}

function resolveDefaultAppUrl(): string {
  try {
    return String(getCanonicalAppUrl()).replace(/\/+$/, '');
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      throw err;
    }
    return 'http://localhost:3000';
  }
}

export type Phase9AutomationServiceOptions = {
  db: SqlExecutor;
  phase8: Phase8TelegramService;
  automationProvider: BusinessAutomationProvider;
  appUrl?: string;
  onEvent?: (event: StructuredObservabilityEvent) => void;
};

export class Phase9AutomationService {
  readonly db: SqlExecutor;
  readonly phase8: Phase8TelegramService;
  readonly automationProvider: BusinessAutomationProvider;
  readonly appUrl: string;
  private readonly onEvent?: ((event: StructuredObservabilityEvent) => void) | undefined;

  constructor(options: Phase9AutomationServiceOptions) {
    this.db = options.db;
    this.phase8 = options.phase8;
    this.automationProvider = options.automationProvider;
    this.appUrl = (options.appUrl ?? resolveDefaultAppUrl()).replace(/\/+$/, '');
    this.onEvent = options.onEvent;
  }

  private emitObservability(event: StructuredObservabilityEvent): void {
    this.onEvent?.(event);
  }

  private requirePrincipal(principal: AuthenticatedPrincipal | null): AuthenticatedPrincipal {
    if (!principal || !principal.userId) {
      throw new Phase4ServiceError(
        401,
        'unauthenticated',
        'Authenticated user session is required.',
      );
    }
    return principal;
  }

  private async requireActiveMembership(
    workspaceId: string,
    userId: string,
  ): Promise<'owner' | 'admin' | 'member'> {
    const res = await this.db.query<{ role: 'owner' | 'admin' | 'member' }>(
      `select role::text as role
         from public.workspace_members
        where workspace_id = $1
          and user_id = $2
          and membership_status = 'active'`,
      [workspaceId, userId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Caller does not have an active membership in the target workspace.',
      );
    }
    return row.role;
  }

  private async loadAuthorizedActiveMeeting(
    userId: string,
    meetingId: string,
    expectedWorkspaceId?: string,
  ): Promise<{
    id: string;
    workspace_id: string;
    title: string;
    company_name: string | null;
    project_name: string | null;
    status: string;
    current_analysis_run_id: string | null;
    current_transcription_run_id: string | null;
  }> {
    const res = await this.db.query<{
      id: string;
      workspace_id: string;
      title: string;
      company_name: string | null;
      project_name: string | null;
      status: string;
      deleted_at: string | null;
      purge_status: string;
      current_analysis_run_id: string | null;
      current_transcription_run_id: string | null;
    }>(
      `select m.id,
              m.workspace_id,
              m.title,
              c.name as company_name,
              p.name as project_name,
              m.status::text as status,
              m.deleted_at,
              m.purge_status::text as purge_status,
              m.current_analysis_run_id,
              m.current_transcription_run_id
         from public.meetings m
         left join public.companies c
           on c.id = m.company_id and c.workspace_id = m.workspace_id
         left join public.projects p
           on p.id = m.project_id and p.workspace_id = m.workspace_id
        where m.id = $1`,
      [meetingId],
    );
    const meeting = res.rows[0];
    if (!meeting) {
      throw new Phase4ServiceError(404, 'not_found', 'Meeting not found.');
    }

    if (expectedWorkspaceId && expectedWorkspaceId !== meeting.workspace_id) {
      throw new Phase4ServiceError(
        403,
        'cross_workspace_access_denied',
        'Meeting does not belong to the requested workspace.',
      );
    }

    await this.requireActiveMembership(meeting.workspace_id, userId);

    if (meeting.deleted_at !== null || meeting.purge_status !== 'active') {
      throw new Phase4ServiceError(
        404,
        'not_found',
        'Meeting has been deleted or is pending purge.',
      );
    }

    return meeting;
  }

  async listWorkspaceConnectors(
    principal: AuthenticatedPrincipal | null,
    workspaceId: string,
  ): Promise<ListWorkspaceConnectorsResponse> {
    const auth = this.requirePrincipal(principal);
    await this.requireActiveMembership(workspaceId, auth.userId);

    const res = await this.db.query<DbWorkspaceConnectorRow>(
      `select *
         from public.workspace_automation_connectors
        where workspace_id = $1
        order by connector_type asc`,
      [workspaceId],
    );

    return {
      workspaceId,
      connectors: res.rows.map(mapConnectorRow),
    };
  }

  async upsertWorkspaceConnector(
    principal: AuthenticatedPrincipal | null,
    workspaceId: string,
    rawInput: UpsertWorkspaceConnectorRequestInput,
  ): Promise<WorkspaceAutomationConnectorDto> {
    const auth = this.requirePrincipal(principal);
    const role = await this.requireActiveMembership(workspaceId, auth.userId);
    if (role !== 'owner' && role !== 'admin') {
      throw new Phase4ServiceError(
        403,
        'unauthorized',
        'Only active workspace owners and admins can configure business automation connectors.',
      );
    }

    const parsed = upsertWorkspaceConnectorRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid connector configuration input.',
      );
    }

    const res = await this.db.query<DbWorkspaceConnectorRow>(
      `insert into public.workspace_automation_connectors (
        workspace_id, connector_type, label, status, endpoint_url, config_metadata, created_by
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7)
      on conflict (workspace_id, connector_type) do update
        set label = excluded.label,
            status = excluded.status,
            endpoint_url = excluded.endpoint_url,
            config_metadata = excluded.config_metadata
      returning *`,
      [
        workspaceId,
        parsed.data.connectorType,
        parsed.data.label,
        parsed.data.status,
        parsed.data.endpointUrl ?? null,
        JSON.stringify(parsed.data.configMetadata ?? {}),
        auth.userId,
      ],
    );

    return mapConnectorRow(res.rows[0]!);
  }

  /**
   * Step 1 of Outbound Business Automation:
   * Builds a deterministic, evidence-linked payload preview from the meeting's finalized intelligence,
   * persists a `pending_confirmation` record with `payload_sha256` and `idempotency_key`,
   * and returns a single-use `confirmationToken`.
   *
   * No external network call is made until `confirmAutomationAction` is called with `confirmed: true`.
   */
  async prepareAutomationAction(
    principal: AuthenticatedPrincipal | null,
    meetingId: string,
    rawInput: PrepareAutomationActionRequestInput,
    options: { now?: Date } = {},
  ): Promise<PrepareAutomationActionResponse> {
    const auth = this.requirePrincipal(principal);
    const parsed = prepareAutomationActionRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid automation action preparation request.',
      );
    }

    const meeting = await this.loadAuthorizedActiveMeeting(
      auth.userId,
      meetingId,
      parsed.data.workspaceId,
    );

    if (meeting.status !== 'ready' || !meeting.current_analysis_run_id) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Meeting intelligence must be finalized (ready) before preparing an outbound business action.',
      );
    }

    const intel = await this.phase8.phase7.phase6.getMeetingIntelligence(
      auth,
      meeting.id,
      meeting.workspace_id,
    );

    const selectedDecisionSet = parsed.data.selectedDecisionIds
      ? new Set(parsed.data.selectedDecisionIds)
      : null;
    const selectedTaskSet = parsed.data.selectedTaskIds
      ? new Set(parsed.data.selectedTaskIds)
      : null;

    const confirmedDecisions = intel.decisions
      .filter(
        (d) => d.status === 'confirmed' && (!selectedDecisionSet || selectedDecisionSet.has(d.id)),
      )
      .map((d) => ({
        id: d.id,
        title: d.decisionKey,
        statement: d.statement,
        segmentIds: d.evidence.map((ev) => ev.transcriptSegmentId),
      }));

    const openTasks = intel.actionItems
      .filter(
        (t) =>
          (t.status === 'open' || t.status === 'in_progress') &&
          (!selectedTaskSet || selectedTaskSet.has(t.id)),
      )
      .map((t) => ({
        id: t.id,
        title: t.title,
        ownerLabel: t.ownerLabel,
        dueDate: t.dueDate,
        segmentIds: t.evidence.map((ev) => ev.transcriptSegmentId),
      }));

    const evidenceBySegment = new Map<string, AutomationPayloadEvidenceItem>();
    const allEvidences = [
      ...(intel.summary?.evidence ?? []),
      ...intel.decisions.flatMap((d) => d.evidence),
      ...intel.actionItems.flatMap((t) => t.evidence),
    ];
    for (const ev of allEvidences) {
      if (!evidenceBySegment.has(ev.transcriptSegmentId)) {
        evidenceBySegment.set(ev.transcriptSegmentId, {
          segmentId: ev.transcriptSegmentId,
          startMs: ev.startMs,
          endMs: ev.endMs,
          quoteText: ev.excerpt,
          deepLinkUrl: `${this.appUrl}/w/${meeting.workspace_id}/meetings/${meeting.id}/transcript?seg=${ev.transcriptSegmentId}&t=${ev.startMs}#${ev.transcriptSegmentId}`,
        });
      }
    }

    const evidenceList = [...evidenceBySegment.values()];
    const payloadPreview: AutomationPayloadPreview = {
      meetingId: meeting.id,
      workspaceId: meeting.workspace_id,
      analysisRunId: meeting.current_analysis_run_id,
      meetingTitle: meeting.title,
      companyName: meeting.company_name,
      projectName: meeting.project_name,
      connectorType: parsed.data.connectorType,
      actionType: parsed.data.actionType,
      summaryHeadline: intel.summary?.headline ?? null,
      summaryTlDr: intel.summary?.tlDr ?? null,
      confirmedDecisions,
      openTasks,
      evidence: evidenceList,
      meetingOverviewUrl: `${this.appUrl}/w/${meeting.workspace_id}/meetings/${meeting.id}`,
    };

    const payloadSha256 = computeTextSha256(JSON.stringify(payloadPreview));

    // Check existing action by (workspace_id, idempotency_key)
    const existingRes = await this.db.query<DbBusinessAutomationActionRow>(
      `select *
         from public.business_automation_actions
        where workspace_id = $1
          and idempotency_key = $2`,
      [meeting.workspace_id, parsed.data.idempotencyKey],
    );
    const existing = existingRes.rows[0];
    if (existing) {
      if (existing.payload_sha256 !== payloadSha256 || existing.meeting_id !== meeting.id) {
        throw new Phase4ServiceError(
          409,
          'idempotency_conflict',
          'Idempotency key has already been used with a different meeting or payload.',
        );
      }
      return {
        action: mapActionRow(existing),
        confirmationToken: null,
        idempotentReused: true,
      };
    }

    // Look up optional active workspace connector for this connectorType
    const connectorRes = await this.db.query<DbWorkspaceConnectorRow>(
      `select *
         from public.workspace_automation_connectors
        where workspace_id = $1
          and connector_type = $2
          and status = 'active'`,
      [meeting.workspace_id, parsed.data.connectorType],
    );
    const connector = connectorRes.rows[0] ?? null;

    const confirmationToken = `confirm_${randomBytes(20).toString('hex')}`;
    const confirmationTokenSha256 = computeTextSha256(confirmationToken);
    const nowIso = (options.now ?? new Date()).toISOString();
    const evidenceSegmentIds = evidenceList.map((e) => e.segmentId);

    const insertRes = await this.db.query<DbBusinessAutomationActionRow>(
      `insert into public.business_automation_actions (
        workspace_id, meeting_id, analysis_run_id, connector_id, connector_type,
        action_type, status, idempotency_key, confirmation_token_sha256,
        payload_sha256, payload_preview, evidence_segment_ids, requested_by, created_at
      )
      values ($1, $2, $3, $4, $5, $6, 'pending_confirmation', $7, $8, $9, $10::jsonb, $11::uuid[], $12, $13)
      returning *`,
      [
        meeting.workspace_id,
        meeting.id,
        meeting.current_analysis_run_id,
        connector?.id ?? null,
        parsed.data.connectorType,
        parsed.data.actionType,
        parsed.data.idempotencyKey,
        confirmationTokenSha256,
        payloadSha256,
        JSON.stringify(payloadPreview),
        evidenceSegmentIds,
        auth.userId,
        nowIso,
      ],
    );
    const actionRow = insertRes.rows[0]!;

    this.emitObservability({
      event: 'automation_action_prepared',
      workspace_id: meeting.workspace_id,
      meeting_id: meeting.id,
      recording_id: null,
      source_id: null,
      chunk_id: null,
      job_id: null,
      sequence_no: null,
      fencing_token: null,
      timestamp: nowIso,
      metadata: {
        action_id: actionRow.id,
        connector_type: actionRow.connector_type,
        action_type: actionRow.action_type,
        evidence_segment_count: evidenceSegmentIds.length,
      },
    });

    return {
      action: mapActionRow(actionRow),
      confirmationToken,
      idempotentReused: false,
    };
  }

  /**
   * Step 2 of Outbound Business Automation:
   * Verifies the explicit user confirmation (`confirmed: true` + `confirmationToken`),
   * records `confirmed_by` and `confirmed_at` in `public.business_automation_actions`,
   * and executes (or enqueues) the outbound action with auditable idempotency.
   */
  async confirmAutomationAction(
    principal: AuthenticatedPrincipal | null,
    meetingId: string,
    actionId: string,
    rawInput: ConfirmAutomationActionRequestInput,
    options: { now?: Date } = {},
  ): Promise<ConfirmAutomationActionResponse> {
    const auth = this.requirePrincipal(principal);
    const parsed = confirmAutomationActionRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Explicit user confirmation is required.',
      );
    }

    const meeting = await this.loadAuthorizedActiveMeeting(
      auth.userId,
      meetingId,
      parsed.data.workspaceId,
    );

    const actionRes = await this.db.query<DbBusinessAutomationActionRow>(
      `select *
         from public.business_automation_actions
        where id = $1
          and meeting_id = $2
          and workspace_id = $3`,
      [actionId, meeting.id, meeting.workspace_id],
    );
    const action = actionRes.rows[0];
    if (!action) {
      throw new Phase4ServiceError(404, 'not_found', 'Business automation action not found.');
    }

    if (action.status === 'cancelled') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cancelled business automation action cannot be confirmed.',
      );
    }

    const incomingTokenHash = computeTextSha256(parsed.data.confirmationToken);
    if (incomingTokenHash !== action.confirmation_token_sha256) {
      throw new Phase4ServiceError(
        403,
        'unauthorized',
        'Invalid confirmation token for outbound business automation action.',
      );
    }

    // Idempotent replay: if already confirmed, executing, or succeeded, return without duplicate execution
    if (
      action.status === 'confirmed' ||
      action.status === 'executing' ||
      action.status === 'succeeded'
    ) {
      return {
        action: mapActionRow(action),
        idempotentReused: true,
      };
    }

    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const confirmedRes = await this.db.query<DbBusinessAutomationActionRow>(
      `update public.business_automation_actions
          set status = 'confirmed',
              confirmed_by = $2,
              confirmed_at = $3
        where id = $1
        returning *`,
      [action.id, auth.userId, nowIso],
    );
    let updatedAction = confirmedRes.rows[0]!;

    this.emitObservability({
      event: 'automation_action_confirmed',
      workspace_id: meeting.workspace_id,
      meeting_id: meeting.id,
      recording_id: null,
      source_id: null,
      chunk_id: null,
      job_id: null,
      sequence_no: null,
      fencing_token: null,
      timestamp: nowIso,
      metadata: {
        action_id: updatedAction.id,
        confirmed_by: auth.userId,
        connector_type: updatedAction.connector_type,
        action_type: updatedAction.action_type,
      },
    });

    if (parsed.data.executeImmediately) {
      updatedAction = await this.executeConfirmedActionRow(updatedAction, { now });
    } else {
      await this.enqueueExecuteAutomationActionJob(updatedAction, { now });
    }

    return {
      action: mapActionRow(updatedAction),
      idempotentReused: false,
    };
  }

  async cancelAutomationAction(
    principal: AuthenticatedPrincipal | null,
    meetingId: string,
    actionId: string,
    options: { workspaceId?: string; now?: Date } = {},
  ): Promise<BusinessAutomationActionDto> {
    const auth = this.requirePrincipal(principal);
    const meeting = await this.loadAuthorizedActiveMeeting(
      auth.userId,
      meetingId,
      options.workspaceId,
    );

    const actionRes = await this.db.query<DbBusinessAutomationActionRow>(
      `select *
         from public.business_automation_actions
        where id = $1
          and meeting_id = $2
          and workspace_id = $3`,
      [actionId, meeting.id, meeting.workspace_id],
    );
    const action = actionRes.rows[0];
    if (!action) {
      throw new Phase4ServiceError(404, 'not_found', 'Business automation action not found.');
    }

    if (action.status !== 'pending_confirmation') {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        `Cannot cancel action in status "${action.status}".`,
      );
    }

    const nowIso = (options.now ?? new Date()).toISOString();
    const updatedRes = await this.db.query<DbBusinessAutomationActionRow>(
      `update public.business_automation_actions
          set status = 'cancelled'
        where id = $1
        returning *`,
      [action.id],
    );

    this.emitObservability({
      event: 'automation_action_cancelled',
      workspace_id: meeting.workspace_id,
      meeting_id: meeting.id,
      recording_id: null,
      source_id: null,
      chunk_id: null,
      job_id: null,
      sequence_no: null,
      fencing_token: null,
      timestamp: nowIso,
      metadata: {
        action_id: action.id,
        cancelled_by: auth.userId,
      },
    });

    return mapActionRow(updatedRes.rows[0]!);
  }

  async enqueueExecuteAutomationActionJob(
    action: DbBusinessAutomationActionRow,
    options: { now?: Date } = {},
  ): Promise<void> {
    const nowIso = (options.now ?? new Date()).toISOString();
    const runRes = await this.db.query<{ recording_id: string; run_number: number }>(
      `select recording_id, run_number
         from public.analysis_runs
        where id = $1
          and meeting_id = $2
          and workspace_id = $3`,
      [action.analysis_run_id, action.meeting_id, action.workspace_id],
    );
    const run = runRes.rows[0];
    if (!run) return;

    const jobKey = `execute_automation_action:${action.id}`;
    await this.db.query(
      `insert into public.processing_jobs (
        workspace_id, meeting_id, recording_id, job_type, generation, status,
        attempt, max_attempts, idempotency_key, scheduled_at, payload
      )
      values ($1, $2, $3, 'execute_automation_action', $4, 'queued', 0, 3, $5, $6, $7::jsonb)
      on conflict do nothing`,
      [
        action.workspace_id,
        action.meeting_id,
        run.recording_id,
        Number(action.attempt_count) + 1,
        jobKey,
        nowIso,
        JSON.stringify({
          automation_action_id: action.id,
        }),
      ],
    );
  }

  async executeConfirmedActionRow(
    action: DbBusinessAutomationActionRow,
    options: { now?: Date } = {},
  ): Promise<DbBusinessAutomationActionRow> {
    if (action.status === 'succeeded') {
      return action;
    }
    if (!action.confirmed_by || !action.confirmed_at) {
      throw new Phase4ServiceError(
        409,
        'invalid_state',
        'Cannot execute an unconfirmed business automation action.',
      );
    }

    const nowIso = (options.now ?? new Date()).toISOString();

    let endpointUrl: string | null = null;
    if (action.connector_id) {
      const connRes = await this.db.query<DbWorkspaceConnectorRow>(
        `select * from public.workspace_automation_connectors where id = $1 and workspace_id = $2`,
        [action.connector_id, action.workspace_id],
      );
      endpointUrl = connRes.rows[0]?.endpoint_url ?? null;
    }

    await this.db.query(
      `update public.business_automation_actions
          set status = 'executing',
              attempt_count = attempt_count + 1
        where id = $1`,
      [action.id],
    );

    try {
      const result = await this.automationProvider.executeAction({
        actionId: action.id,
        workspaceId: action.workspace_id,
        meetingId: action.meeting_id,
        connectorType: action.connector_type,
        actionType: action.action_type,
        idempotencyKey: action.idempotency_key,
        payloadSha256: action.payload_sha256,
        payload: action.payload_preview,
        endpointUrl,
        confirmedBy: action.confirmed_by,
        confirmedAt: toIsoString(action.confirmed_at),
      });

      const succeededRes = await this.db.query<DbBusinessAutomationActionRow>(
        `update public.business_automation_actions
            set status = 'succeeded',
                executed_at = $2,
                external_reference_id = $3,
                external_url = $4,
                error_code = null,
                error_message = null
          where id = $1
          returning *`,
        [action.id, result.executedAt, result.externalReferenceId, result.externalUrl],
      );

      this.emitObservability({
        event: 'automation_action_succeeded',
        workspace_id: action.workspace_id,
        meeting_id: action.meeting_id,
        recording_id: null,
        source_id: null,
        chunk_id: null,
        job_id: null,
        sequence_no: null,
        fencing_token: null,
        timestamp: nowIso,
        metadata: {
          action_id: action.id,
          connector_type: action.connector_type,
          action_type: action.action_type,
          external_reference_id: result.externalReferenceId,
        },
      });

      return succeededRes.rows[0]!;
    } catch (cause) {
      const errCode =
        cause instanceof AutomationProviderError ? cause.code : 'automation_execution_failed';
      const errMsg = cause instanceof Error ? cause.message : String(cause);

      const failedRes = await this.db.query<DbBusinessAutomationActionRow>(
        `update public.business_automation_actions
            set status = 'failed',
                error_code = $2,
                error_message = $3
          where id = $1
          returning *`,
        [action.id, errCode.slice(0, 80), errMsg.slice(0, 500)],
      );

      this.emitObservability({
        event: 'automation_action_failed',
        workspace_id: action.workspace_id,
        meeting_id: action.meeting_id,
        recording_id: null,
        source_id: null,
        chunk_id: null,
        job_id: null,
        sequence_no: null,
        fencing_token: null,
        timestamp: nowIso,
        metadata: {
          action_id: action.id,
          connector_type: action.connector_type,
          action_type: action.action_type,
          error_code: errCode,
        },
      });

      return failedRes.rows[0]!;
    }
  }

  /**
   * Creates an auditable meeting export (`md | txt | csv | json`) derived strictly from
   * persisted canonical intelligence and transcript records, recording the export in `public.meeting_exports`.
   */
  async createMeetingExport(
    principal: AuthenticatedPrincipal | null,
    meetingId: string,
    rawInput: CreateMeetingExportRequestInput = {},
    options: { now?: Date } = {},
  ): Promise<CreateMeetingExportResponse> {
    const auth = this.requirePrincipal(principal);
    const parsed = createMeetingExportRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        parsed.error.issues[0]?.message ?? 'Invalid meeting export request.',
      );
    }

    const meeting = await this.loadAuthorizedActiveMeeting(
      auth.userId,
      meetingId,
      parsed.data.workspaceId,
    );

    const intel = meeting.current_analysis_run_id
      ? await this.phase8.phase7.phase6.getMeetingIntelligence(
          auth,
          meeting.id,
          meeting.workspace_id,
        )
      : null;

    const transcript =
      parsed.data.includeTranscript && meeting.current_transcription_run_id
        ? await this.phase8.phase7.phase6.phase5.getMeetingTranscript(auth, meeting.id)
        : null;

    const slug =
      meeting.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'meeting';

    const format = parsed.data.format;
    let filename = `${slug}.${format}`;
    let mediaType = 'text/plain';
    let content = '';

    if (format === 'json') {
      mediaType = 'application/json';
      content = JSON.stringify(
        {
          schema: 'suhbat.meeting-export/1',
          generatedFrom: 'canonical_workspace_database',
          meeting: {
            id: meeting.id,
            workspaceId: meeting.workspace_id,
            title: meeting.title,
            companyName: meeting.company_name,
            projectName: meeting.project_name,
            status: meeting.status,
            analysisRunId: meeting.current_analysis_run_id,
          },
          summary: intel?.summary ?? null,
          decisions: intel?.decisions ?? [],
          actionItems: intel?.actionItems ?? [],
          facts: intel?.facts ?? [],
          questions: intel?.questions ?? [],
          ideas: intel?.ideas ?? [],
          commitments: intel?.commitments ?? [],
          risks: intel?.risks ?? [],
          transcript: parsed.data.includeTranscript
            ? (transcript?.segments ?? [])
            : 'excluded_by_request',
        },
        null,
        2,
      );
    } else if (format === 'csv') {
      filename = `${slug}-records.csv`;
      mediaType = 'text/csv';
      const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = ['kind,id,title,status,owner,due_date,evidence_segments'];
      for (const d of intel?.decisions ?? []) {
        lines.push(
          [
            'decision',
            d.id,
            `${d.decisionKey} — ${d.statement}`,
            d.status,
            '',
            '',
            d.evidence.map((e) => e.transcriptSegmentId).join(';'),
          ]
            .map(csvCell)
            .join(','),
        );
      }
      for (const t of intel?.actionItems ?? []) {
        lines.push(
          [
            'task',
            t.id,
            t.title,
            t.status,
            t.ownerLabel ?? '',
            t.dueDate ?? '',
            t.evidence.map((e) => e.transcriptSegmentId).join(';'),
          ]
            .map(csvCell)
            .join(','),
        );
      }
      content = `${lines.join('\n')}\n`;
    } else {
      mediaType = format === 'md' ? 'text/markdown' : 'text/plain';
      const h1 = format === 'md' ? `# ${meeting.title}` : meeting.title.toUpperCase();
      const h2 = (t: string) => (format === 'md' ? `## ${t}` : t.toUpperCase());
      const out: string[] = [
        h1,
        `Company: ${meeting.company_name ?? 'not linked'}`,
        `Project: ${meeting.project_name ?? 'not linked'}`,
        `Status: ${meeting.status}`,
        '',
        h2('Summary'),
        intel?.summary?.tlDr ?? intel?.summary?.headline ?? 'No summary recorded yet.',
        '',
        h2('Decisions'),
        ...(intel && intel.decisions.length > 0
          ? intel.decisions.map(
              (d) =>
                `- [${d.status}] ${d.decisionKey}: ${d.statement} (evidence: ${d.evidence.map((e) => e.transcriptSegmentId).join(', ')})`,
            )
          : ['No decisions recorded.']),
        '',
        h2('Tasks'),
        ...(intel && intel.actionItems.length > 0
          ? intel.actionItems.map(
              (t) =>
                `- [${t.status}] ${t.title} — ${t.ownerLabel ?? 'Unassigned'}${t.dueDate ? ` (due ${t.dueDate})` : ''} (evidence: ${t.evidence.map((e) => e.transcriptSegmentId).join(', ')})`,
            )
          : ['No tasks recorded.']),
      ];

      if (parsed.data.includeTranscript) {
        out.push('', h2('Transcript'));
        if (transcript && transcript.segments.length > 0) {
          for (const seg of transcript.segments) {
            out.push(`[${seg.startMs}ms-${seg.endMs}ms] ${seg.text}`);
          }
        } else {
          out.push('No transcript attached.');
        }
      }
      content = `${out.join('\n')}\n`;
    }

    const contentBytes = new TextEncoder().encode(content);
    const contentSha256 = computeSha256Hex(contentBytes);
    const nowIso = (options.now ?? new Date()).toISOString();

    const insertRes = await this.db.query<DbMeetingExportRow>(
      `insert into public.meeting_exports (
        workspace_id, meeting_id, analysis_run_id, export_format,
        include_transcript, filename, byte_size, content_sha256, exported_by, created_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning *`,
      [
        meeting.workspace_id,
        meeting.id,
        meeting.current_analysis_run_id,
        format,
        parsed.data.includeTranscript,
        filename,
        contentBytes.byteLength,
        contentSha256,
        auth.userId,
        nowIso,
      ],
    );
    const exportRow = insertRes.rows[0]!;

    this.emitObservability({
      event: 'meeting_exported',
      workspace_id: meeting.workspace_id,
      meeting_id: meeting.id,
      recording_id: null,
      source_id: null,
      chunk_id: null,
      job_id: null,
      sequence_no: null,
      fencing_token: null,
      timestamp: nowIso,
      metadata: {
        export_id: exportRow.id,
        format,
        include_transcript: parsed.data.includeTranscript,
        byte_size: contentBytes.byteLength,
      },
    });

    return {
      exportRecord: mapExportRow(exportRow),
      filename,
      mediaType,
      content,
    };
  }

  async listMeetingAutomations(
    principal: AuthenticatedPrincipal | null,
    meetingId: string,
    workspaceId?: string,
  ): Promise<ListMeetingAutomationsResponse> {
    const auth = this.requirePrincipal(principal);
    const meeting = await this.loadAuthorizedActiveMeeting(auth.userId, meetingId, workspaceId);

    const [actionsRes, exportsRes] = await Promise.all([
      this.db.query<DbBusinessAutomationActionRow>(
        `select *
           from public.business_automation_actions
          where workspace_id = $1
            and meeting_id = $2
          order by created_at desc`,
        [meeting.workspace_id, meeting.id],
      ),
      this.db.query<DbMeetingExportRow>(
        `select *
           from public.meeting_exports
          where workspace_id = $1
            and meeting_id = $2
          order by created_at desc`,
        [meeting.workspace_id, meeting.id],
      ),
    ]);

    return {
      meetingId: meeting.id,
      workspaceId: meeting.workspace_id,
      actions: actionsRes.rows.map(mapActionRow),
      exports: exportsRes.rows.map(mapExportRow),
    };
  }
}

export class Phase9AutomationWorker {
  readonly service: Phase9AutomationService;
  readonly phase8Worker: Phase8TelegramWorker;

  constructor(service: Phase9AutomationService) {
    this.service = service;
    this.phase8Worker = new Phase8TelegramWorker(service.phase8);
  }

  private get db(): SqlExecutor {
    return this.service.db;
  }

  async claimNextJob(
    workerId: string,
    options: ClaimJobOptions = {},
  ): Promise<ProcessingJobDto | null> {
    return this.phase8Worker.claimNextJob(workerId, options);
  }

  async executeClaimedAutomationActionJob(
    workerId: string,
    job: ProcessingJobDto,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto> {
    if (job.jobType !== 'execute_automation_action') {
      throw new Phase4ServiceError(
        400,
        'validation_failed',
        `Expected execute_automation_action job, got ${job.jobType}.`,
      );
    }

    const now = options.now ?? new Date();
    const actionId =
      typeof job.payload.automation_action_id === 'string' ? job.payload.automation_action_id : '';

    const actionRes = await this.db.query<DbBusinessAutomationActionRow>(
      `select baa.*
         from public.business_automation_actions baa
         join public.meetings m
           on m.id = baa.meeting_id
          and m.workspace_id = baa.workspace_id
        where baa.id = $1
          and baa.workspace_id = $2
          and m.deleted_at is null
          and m.purge_status = 'active'`,
      [actionId, job.workspaceId],
    );
    const action = actionRes.rows[0];

    if (
      !action ||
      !action.confirmed_by ||
      !action.confirmed_at ||
      (action.status !== 'confirmed' && action.status !== 'failed')
    ) {
      return this.phase8Worker.phase7Worker.phase6Worker.phase5Worker.phase4Worker.completeJob(
        workerId,
        job.id,
        job.fencingToken,
        {
          now,
          metadata: {
            skipped: true,
            reason: 'action_not_confirmed_or_meeting_inactive',
          },
        },
      );
    }

    const executed = await this.service.executeConfirmedActionRow(action, { now });

    return this.phase8Worker.phase7Worker.phase6Worker.phase5Worker.phase4Worker.completeJob(
      workerId,
      job.id,
      job.fencingToken,
      {
        now,
        metadata: {
          action_id: executed.id,
          action_status: executed.status,
          external_reference_id: executed.external_reference_id,
        },
      },
    );
  }

  async runNextJob(
    workerId: string,
    options: { now?: Date } = {},
  ): Promise<ProcessingJobDto | null> {
    await this.phase8Worker.ensureStageTransitionJobsEnqueued(options);

    const job = await this.claimNextJob(workerId, options);
    if (!job) return null;

    if (job.jobType === 'execute_automation_action') {
      return this.executeClaimedAutomationActionJob(workerId, job, options);
    }
    if (job.jobType === 'send_telegram_notifications') {
      return this.phase8Worker.executeClaimedSendTelegramNotificationsJob(workerId, job, options);
    }
    if (job.jobType === 'generate_embeddings') {
      return this.phase8Worker.phase7Worker.executeClaimedGenerateEmbeddingsJob(
        workerId,
        job,
        options,
      );
    }
    if (job.jobType === 'index_knowledge') {
      return this.phase8Worker.phase7Worker.executeClaimedIndexKnowledgeJob(workerId, job, options);
    }
    return this.phase8Worker.phase7Worker.phase6Worker.executeClaimedJob(workerId, job, options);
  }

  async runUntilIdle(
    workerId: string,
    options: { now?: Date; maxJobs?: number } = {},
  ): Promise<ProcessingJobDto[]> {
    const processed: ProcessingJobDto[] = [];
    const maxJobs = options.maxJobs ?? 50;
    while (processed.length < maxJobs) {
      const result = await this.runNextJob(workerId, options);
      if (!result) break;
      processed.push(result);
    }
    return processed;
  }
}
