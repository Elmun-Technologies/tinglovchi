import { describe, expect, it } from 'vitest';
import {
  confirmAutomationActionRequestSchema,
  createMeetingExportRequestSchema,
  prepareAutomationActionRequestSchema,
  processingEventTypeSchema,
  processingJobTypeSchema,
  upsertWorkspaceConnectorRequestSchema,
} from '@suhbat/contracts';
import {
  AutomationProviderError,
  FakeBusinessAutomationProvider,
  HttpBusinessAutomationProvider,
  createBusinessAutomationProviderFromEnv,
  isForbiddenInternalWebhookHost,
} from '@suhbat/database/automation-provider';

describe('Phase 9 Business Automation contracts & provider unit tests', () => {
  it('validates processingJobTypeSchema and processingEventTypeSchema for Phase 9', () => {
    expect(processingJobTypeSchema.parse('execute_automation_action')).toBe(
      'execute_automation_action',
    );
    expect(processingEventTypeSchema.parse('automation_action_prepared')).toBe(
      'automation_action_prepared',
    );
    expect(processingEventTypeSchema.parse('automation_action_confirmed')).toBe(
      'automation_action_confirmed',
    );
    expect(processingEventTypeSchema.parse('automation_action_succeeded')).toBe(
      'automation_action_succeeded',
    );
    expect(processingEventTypeSchema.parse('automation_action_failed')).toBe(
      'automation_action_failed',
    );
    expect(processingEventTypeSchema.parse('automation_action_cancelled')).toBe(
      'automation_action_cancelled',
    );
    expect(processingEventTypeSchema.parse('meeting_exported')).toBe('meeting_exported');
  });

  it('validates connector, prepare action, explicit confirmation, and export schemas', () => {
    const conn = upsertWorkspaceConnectorRequestSchema.parse({
      connectorType: 'amocrm',
      label: 'Tashkent Sales amoCRM',
      endpointUrl: 'https://crm.suhbat.example/webhook',
    });
    expect(conn.status).toBe('active');

    const prep = prepareAutomationActionRequestSchema.parse({
      connectorType: 'amocrm',
      actionType: 'sync_crm_tasks',
      idempotencyKey: 'idem-crm-tasks-0001',
    });
    expect(prep.idempotencyKey).toBe('idem-crm-tasks-0001');

    // Explicit user confirmation must be literal true
    expect(() =>
      confirmAutomationActionRequestSchema.parse({
        confirmed: false,
        confirmationToken: 'confirm_0123456789abcdef0123456789abcdef',
      }),
    ).toThrow();

    const conf = confirmAutomationActionRequestSchema.parse({
      confirmed: true,
      confirmationToken: 'confirm_0123456789abcdef0123456789abcdef',
    });
    expect(conf.confirmed).toBe(true);
    expect(conf.executeImmediately).toBe(true);

    const expReq = createMeetingExportRequestSchema.parse({});
    expect(expReq.format).toBe('md');
    expect(expReq.includeTranscript).toBe(false);
  });

  it('FakeBusinessAutomationProvider records executed actions and simulates failures', async () => {
    const provider = new FakeBusinessAutomationProvider();
    const out = await provider.executeAction({
      actionId: '90000000-0000-4000-8000-000000000001',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      meetingId: '50000000-0000-4000-8000-000000000001',
      connectorType: 'amocrm',
      actionType: 'sync_crm_tasks',
      idempotencyKey: 'idem-crm-tasks-0001',
      payloadSha256: 'a'.repeat(64),
      confirmedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      confirmedAt: '2026-10-07T10:00:00.000Z',
      payload: {
        meetingId: '50000000-0000-4000-8000-000000000001',
        workspaceId: '10000000-0000-4000-8000-000000000001',
        analysisRunId: '60000000-0000-4000-8000-000000000001',
        meetingTitle: 'Q4 Logistics Sync',
        companyName: 'Alpha Logistics',
        projectName: 'Fleet Rollout',
        connectorType: 'amocrm',
        actionType: 'sync_crm_tasks',
        summaryHeadline: 'Approved pilot budget',
        summaryTlDr: 'Pilot budget and timeline confirmed.',
        confirmedDecisions: [],
        openTasks: [],
        evidence: [],
        meetingOverviewUrl:
          'https://app.suhbat.ai/w/10000000-0000-4000-8000-000000000001/meetings/50000000-0000-4000-8000-000000000001',
      },
    });

    expect(out.externalReferenceId).toBe('ext_amocrm_1');
    expect(provider.getExecutedActions()).toHaveLength(1);

    provider.injectFailureForConnector('amocrm', {
      code: 'provider_unavailable',
      message: 'amoCRM endpoint timed out',
      retryable: true,
    });

    await expect(
      provider.executeAction({
        actionId: '90000000-0000-4000-8000-000000000002',
        workspaceId: '10000000-0000-4000-8000-000000000001',
        meetingId: '50000000-0000-4000-8000-000000000001',
        connectorType: 'amocrm',
        actionType: 'sync_crm_tasks',
        idempotencyKey: 'idem-crm-tasks-0002',
        payloadSha256: 'b'.repeat(64),
        confirmedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        confirmedAt: '2026-10-07T10:01:00.000Z',
        payload: {
          meetingId: '50000000-0000-4000-8000-000000000001',
          workspaceId: '10000000-0000-4000-8000-000000000001',
          analysisRunId: '60000000-0000-4000-8000-000000000001',
          meetingTitle: 'Q4 Logistics Sync',
          companyName: 'Alpha Logistics',
          projectName: 'Fleet Rollout',
          connectorType: 'amocrm',
          actionType: 'sync_crm_tasks',
          summaryHeadline: 'Approved pilot budget',
          summaryTlDr: 'Pilot budget and timeline confirmed.',
          confirmedDecisions: [],
          openTasks: [],
          evidence: [],
          meetingOverviewUrl:
            'https://app.suhbat.ai/w/10000000-0000-4000-8000-000000000001/meetings/50000000-0000-4000-8000-000000000001',
        },
      }),
    ).rejects.toBeInstanceOf(AutomationProviderError);
  });

  it('HttpBusinessAutomationProvider sends idempotency headers and fails fast without silent fallback', async () => {
    expect(() =>
      createBusinessAutomationProviderFromEnv({
        SUHBAT_AUTOMATION_PROVIDER: 'http',
      }),
    ).toThrow(AutomationProviderError);

    let capturedHeaders = new Headers();
    const httpProvider = new HttpBusinessAutomationProvider({
      signingSecret: 'wh-sign-secret',
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            externalReferenceId: 'crm_deal_991',
            externalUrl: 'https://crm.suhbat.example/deals/991',
          }),
          { status: 200 },
        );
      },
    });

    const samplePayload = {
      meetingId: '50000000-0000-4000-8000-000000000001',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      analysisRunId: '60000000-0000-4000-8000-000000000001',
      meetingTitle: 'Q4 Logistics Sync',
      companyName: 'Alpha Logistics',
      projectName: 'Fleet Rollout',
      connectorType: 'amocrm' as const,
      actionType: 'sync_crm_summary' as const,
      summaryHeadline: 'Approved pilot budget',
      summaryTlDr: 'Pilot budget and timeline confirmed.',
      confirmedDecisions: [],
      openTasks: [],
      evidence: [],
      meetingOverviewUrl:
        'https://app.suhbat.ai/w/10000000-0000-4000-8000-000000000001/meetings/50000000-0000-4000-8000-000000000001',
    };

    const res = await httpProvider.executeAction({
      actionId: '90000000-0000-4000-8000-000000000003',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      meetingId: '50000000-0000-4000-8000-000000000001',
      connectorType: 'amocrm',
      actionType: 'sync_crm_summary',
      idempotencyKey: 'idem-crm-summary-0003',
      payloadSha256: 'c'.repeat(64),
      endpointUrl: 'https://crm.suhbat.example/webhook',
      confirmedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      confirmedAt: '2026-10-07T10:02:00.000Z',
      payload: samplePayload,
    });

    expect(res.externalReferenceId).toBe('crm_deal_991');
    expect(capturedHeaders?.get('idempotency-key')).toBe('idem-crm-summary-0003');
    expect(capturedHeaders?.get('x-suhbat-payload-sha256')).toBe('c'.repeat(64));
    expect(capturedHeaders?.get('x-suhbat-webhook-secret')).toBe('wh-sign-secret');
  });

  it('enforces comprehensive SSRF protections (IPv4/IPv6 ranges, IPv4-mapped IPv6, alternate IP encodings, DNS rebinding, and redirect revalidation)', async () => {
    // 1. Direct classification of prohibited vs public literals
    for (const prohibited of [
      'localhost',
      'api.localhost',
      'printer.local',
      'metadata.google.internal',
      '0.0.0.0',
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '10.255.255.254',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '::1',
      '[::1]',
      '[0:0:0:0:0:0:0:1]',
      '::',
      '[fe80::1]',
      '[febf::abcd]',
      'fe80::1%eth0',
      '[fc00::1]',
      '[fd12:3456:789a::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::ffff:10.0.0.1]',
      '[::ffff:169.254.169.254]',
      '[::ffff:192.168.1.1]',
      '[::ffff:172.16.0.1]',
      '[64:ff9b::127.0.0.1]',
      '[2002:7f00:0001::1]',
      '2130706433', // 127.0.0.1 decimal integer
      '0x7f000001', // 127.0.0.1 hex
      '0177.0.0.1', // 127.0.0.1 octal
      '127.1', // 127.0.0.1 shorthand
      '0xa9fea9fe', // 169.254.169.254 hex
    ]) {
      expect(isForbiddenInternalWebhookHost(prohibited)).toBe(true);
    }

    for (const allowedPublic of [
      '93.184.216.34',
      '172.15.0.1',
      '172.32.0.1',
      '[2606:2800:220:1:248:1893:25c8:1946]',
      '[::ffff:93.184.216.34]',
      'hooks.partner.example',
    ]) {
      expect(isForbiddenInternalWebhookHost(allowedPublic)).toBe(false);
    }

    const baseReq = {
      actionId: '90000000-0000-4000-8000-000000000077',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      meetingId: '50000000-0000-4000-8000-000000000001',
      connectorType: 'webhook_n8n' as const,
      actionType: 'trigger_n8n_workflow' as const,
      idempotencyKey: 'idem-ssrf-77',
      payloadSha256: 'd'.repeat(64),
      confirmedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      confirmedAt: '2026-10-07T10:05:00.000Z',
      payload: {
        meetingId: '50000000-0000-4000-8000-000000000001',
        workspaceId: '10000000-0000-4000-8000-000000000001',
        analysisRunId: '60000000-0000-4000-8000-000000000001',
        meetingTitle: 'SSRF Test',
        companyName: null,
        projectName: null,
        connectorType: 'webhook_n8n' as const,
        actionType: 'trigger_n8n_workflow' as const,
        summaryHeadline: 'Headline',
        summaryTlDr: 'TLDR',
        confirmedDecisions: [],
        openTasks: [],
        evidence: [],
        meetingOverviewUrl:
          'https://app.suhbat.ai/w/10000000-0000-4000-8000-000000000001/meetings/50000000-0000-4000-8000-000000000001',
      },
    };

    // 2. Rejects alternate IPv4 and IPv6 URLs before touching fetchImpl
    let fetchCount = 0;
    const strictProvider = new HttpBusinessAutomationProvider({
      signingSecret: 'top-secret-wh-key',
      dnsLookup: async (host) => {
        if (host === 'rebind-ipv4.partner.example') {
          return [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.42', family: 4 },
          ];
        }
        if (host === 'rebind-ipv6.partner.example') {
          return [{ address: 'fd00::1234', family: 6 }];
        }
        if (host === 'rebind-mapped.partner.example') {
          return [{ address: '::ffff:169.254.169.254', family: 6 }];
        }
        if (host === 'internal-hop.partner.example') {
          return [{ address: '192.168.10.5', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      },
      fetchImpl: async (input) => {
        fetchCount += 1;
        const url = String(input);
        if (url === 'https://public-redirect-private-ip.partner.example/hook') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://169.254.169.254/latest/meta-data' },
          });
        }
        if (url === 'https://public-redirect-private-dns.partner.example/hook') {
          return new Response(null, {
            status: 307,
            headers: { location: 'https://internal-hop.partner.example/admin' },
          });
        }
        if (url === 'https://public-redirect-http.partner.example/hook') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://hooks.partner.example/insecure' },
          });
        }
        if (url.startsWith('https://loop-redirect.partner.example/')) {
          return new Response(null, {
            status: 302,
            headers: { location: `https://loop-redirect.partner.example/hop-${fetchCount}` },
          });
        }
        return new Response(JSON.stringify({ externalReferenceId: 'ok' }), { status: 200 });
      },
      maxRedirects: 2,
    });

    for (const blockedUrl of [
      'https://2130706433/webhook',
      'https://0x7f000001/webhook',
      'https://0177.0.0.1/webhook',
      'https://127.1/webhook',
      'https://[::1]/webhook',
      'https://[fe80::1]/webhook',
      'https://[fd00::1]/webhook',
      'https://[::ffff:127.0.0.1]/webhook',
      'https://[::ffff:169.254.169.254]/webhook',
      'https://rebind-ipv4.partner.example/webhook',
      'https://rebind-ipv6.partner.example/webhook',
      'https://rebind-mapped.partner.example/webhook',
    ]) {
      await expect(
        strictProvider.executeAction({ ...baseReq, endpointUrl: blockedUrl }),
      ).rejects.toMatchObject({
        code: 'provider_not_configured',
        retryable: false,
      });
    }
    expect(fetchCount).toBe(0);

    // 3. Rejects redirects to private IP, private DNS resolution, or HTTP downgrade
    for (const badRedirectUrl of [
      'https://public-redirect-private-ip.partner.example/hook',
      'https://public-redirect-private-dns.partner.example/hook',
      'https://public-redirect-http.partner.example/hook',
    ]) {
      await expect(
        strictProvider.executeAction({ ...baseReq, endpointUrl: badRedirectUrl }),
      ).rejects.toMatchObject({
        code: 'provider_not_configured',
        retryable: false,
      });
    }

    // 4. Bounds redirect count
    await expect(
      strictProvider.executeAction({
        ...baseReq,
        endpointUrl: 'https://loop-redirect.partner.example/start',
      }),
    ).rejects.toMatchObject({
      code: 'provider_rejected',
      retryable: false,
    });
  });
});
