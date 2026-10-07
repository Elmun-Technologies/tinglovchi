import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type {
  AutomationActionType,
  AutomationConnectorType,
  AutomationPayloadPreview,
} from '@suhbat/contracts';

export type WebhookDnsLookupRecord = {
  address: string;
  family?: number;
};

export type WebhookDnsLookupFn = (
  hostname: string,
) => Promise<ReadonlyArray<WebhookDnsLookupRecord>>;

async function defaultWebhookDnsLookup(
  hostname: string,
): Promise<ReadonlyArray<WebhookDnsLookupRecord>> {
  return lookup(hostname, { all: true, verbatim: true });
}

function parseIpv4Octets(input: string): [number, number, number, number] | null {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input)) {
    return null;
  }
  const parts = input.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const n = Number.parseInt(part, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isProhibitedIpv4Octets([a, b, c]: [number, number, number, number]): boolean {
  // 0.0.0.0/8 (unspecified / "this" network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC 1918 private)
  if (a === 10) return true;
  // 100.64.0.0/10 (RFC 6598 Carrier-Grade NAT / shared address space)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local / cloud metadata service)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC 1918 private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments) & 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16 (RFC 1918 private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved / broadcast)
  if (a >= 224) return true;
  return false;
}

function parseIpv6Words(rawInput: string): number[] | null {
  const trimmed = rawInput.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (!unbracketed || !unbracketed.includes(':') || unbracketed.includes('%')) {
    return null;
  }

  let normalized = unbracketed;
  const lastColonIdx = normalized.lastIndexOf(':');
  const lastSegment = normalized.slice(lastColonIdx + 1);
  if (lastSegment.includes('.')) {
    const ipv4 = parseIpv4Octets(lastSegment);
    if (!ipv4) {
      return null;
    }
    const highWord = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lowWord = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, lastColonIdx + 1)}${highWord}:${lowWord}`;
  }

  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const words: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/i.test(token)) {
        return null;
      }
      words.push(Number.parseInt(token, 16));
    }
    return words;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSide(doubleColonParts[0]!);
    const right = parseSide(doubleColonParts[1]!);
    if (!left || !right || left.length + right.length > 7) {
      return null;
    }
    const missingZeros = 8 - (left.length + right.length);
    return [...left, ...new Array<number>(missingZeros).fill(0), ...right];
  }

  const full = parseSide(normalized);
  if (!full || full.length !== 8) {
    return null;
  }
  return full;
}

function isProhibitedIpv6Words(w: number[]): boolean {
  if (w.length !== 8) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // Unspecified ::/128
  if (w.every((word) => word === 0)) return true;
  // Loopback ::1/128
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1)
    return true;

  // IPv4-mapped ::ffff:0:0/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return isProhibitedIpv4Octets([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  // IPv4-translated ::ffff:0:0:0/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) {
    return isProhibitedIpv4Octets([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  // IPv4-compatible ::/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isProhibitedIpv4Octets([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  // NAT64 well-known prefix 64:ff9b::/96 and 64:ff9b:1::/48
  if (w0 === 0x0064 && w1 === 0xff9b) {
    return isProhibitedIpv4Octets([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  // 6to4 2002::/16 (embeds IPv4 in w1..w2)
  if (w0 === 0x2002) {
    return isProhibitedIpv4Octets([w1 >> 8, w1 & 0xff, w2 >> 8, w2 & 0xff]);
  }
  // Teredo 2001:0000::/32, Documentation 2001:db8::/32, ORCHIDv2 2001:20::/28
  if (w0 === 0x2001 && (w1 === 0x0000 || w1 === 0x0db8 || (w1 & 0xfff0) === 0x0020)) {
    return true;
  }
  // Unique-local fc00::/7 (fc00:: - fdff::)
  if ((w0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (fe80:: - febf::)
  if ((w0 & 0xffc0) === 0xfe80) return true;
  // Site-local deprecated fec0::/10
  if ((w0 & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((w0 & 0xff00) === 0xff00) return true;

  return false;
}

function isIpLiteralHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  if (lower.startsWith('[') || lower.includes(':')) {
    return parseIpv6Words(lower) !== null;
  }
  return parseIpv4Octets(lower) !== null;
}

/**
 * Checks whether a hostname or IP literal (IPv4, IPv6, IPv4-mapped IPv6, or alternate IPv4 encoding)
 * targets a prohibited local, private, link-local, loopback, or reserved address.
 */
export function isForbiddenInternalWebhookHost(hostOrIp: string): boolean {
  const raw = hostOrIp.trim().toLowerCase().replace(/\.+$/, '');
  if (!raw || raw.includes('%')) {
    return true;
  }

  if (
    raw === 'localhost' ||
    raw.endsWith('.localhost') ||
    raw.endsWith('.local') ||
    raw.endsWith('.internal') ||
    raw.endsWith('.home.arpa') ||
    raw === 'instance-data'
  ) {
    return true;
  }

  // Direct IPv6 check (bracketed or unbracketed)
  if (raw.startsWith('[') || raw.includes(':')) {
    const words = parseIpv6Words(raw);
    if (!words) return true;
    return isProhibitedIpv6Words(words);
  }

  // Direct canonical IPv4 check
  const directIpv4 = parseIpv4Octets(raw);
  if (directIpv4) {
    return isProhibitedIpv4Octets(directIpv4);
  }

  // Check if WHATWG URL parser canonicalizes an alternate IPv4 representation (decimal int, hex, octal, shorthand)
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(raw)) {
    try {
      const canonicalHost = new URL(`https://${raw}`).hostname.toLowerCase();
      const canonicalIpv4 = parseIpv4Octets(canonicalHost);
      if (!canonicalIpv4) return true;
      return isProhibitedIpv4Octets(canonicalIpv4);
    } catch {
      return true;
    }
  }

  return false;
}

export type AutomationExecuteRequest = {
  actionId: string;
  workspaceId: string;
  meetingId: string;
  connectorType: AutomationConnectorType;
  actionType: AutomationActionType;
  idempotencyKey: string;
  payloadSha256: string;
  payload: AutomationPayloadPreview;
  endpointUrl?: string | null;
  confirmedBy: string;
  confirmedAt: string;
};

export type AutomationExecuteResponse = {
  provider: string;
  externalReferenceId: string;
  externalUrl: string | null;
  executedAt: string;
};

export type AutomationProviderErrorCode =
  'provider_not_configured' | 'provider_unavailable' | 'provider_rejected' | 'rate_limited';

export class AutomationProviderError extends Error {
  readonly code: AutomationProviderErrorCode;
  readonly retryable: boolean;

  constructor(params: { code: AutomationProviderErrorCode; message: string; retryable: boolean }) {
    super(params.message);
    this.name = 'AutomationProviderError';
    this.code = params.code;
    this.retryable = params.retryable;
  }
}

export interface BusinessAutomationProvider {
  readonly providerName: string;
  executeAction(request: AutomationExecuteRequest): Promise<AutomationExecuteResponse>;
}

export class FakeBusinessAutomationProvider implements BusinessAutomationProvider {
  readonly providerName = 'fake';
  private counter = 0;
  private readonly executed: Array<AutomationExecuteRequest & AutomationExecuteResponse> = [];
  private readonly injectedFailuresByConnector = new Map<
    AutomationConnectorType,
    { code: AutomationProviderErrorCode; message: string; retryable: boolean }
  >();
  private readonly injectedFailuresByActionId = new Map<
    string,
    { code: AutomationProviderErrorCode; message: string; retryable: boolean }
  >();

  getExecutedActions(): ReadonlyArray<AutomationExecuteRequest & AutomationExecuteResponse> {
    return this.executed;
  }

  clearExecutedActions(): void {
    this.executed.length = 0;
  }

  injectFailureForConnector(
    connectorType: AutomationConnectorType,
    failure: { code: AutomationProviderErrorCode; message: string; retryable: boolean },
  ): void {
    this.injectedFailuresByConnector.set(connectorType, failure);
  }

  clearFailureForConnector(connectorType: AutomationConnectorType): void {
    this.injectedFailuresByConnector.delete(connectorType);
  }

  injectFailureForActionId(
    actionId: string,
    failure: { code: AutomationProviderErrorCode; message: string; retryable: boolean },
  ): void {
    this.injectedFailuresByActionId.set(actionId, failure);
  }

  clearFailureForActionId(actionId: string): void {
    this.injectedFailuresByActionId.delete(actionId);
  }

  async executeAction(request: AutomationExecuteRequest): Promise<AutomationExecuteResponse> {
    const actionFail = this.injectedFailuresByActionId.get(request.actionId);
    if (actionFail) {
      throw new AutomationProviderError(actionFail);
    }
    const connectorFail = this.injectedFailuresByConnector.get(request.connectorType);
    if (connectorFail) {
      throw new AutomationProviderError(connectorFail);
    }

    this.counter += 1;
    const externalReferenceId = `ext_${request.connectorType}_${this.counter}`;
    const externalUrl = `https://integrations.suhbat.example/${request.connectorType}/${externalReferenceId}`;
    const executedAt = new Date().toISOString();

    const record: AutomationExecuteRequest & AutomationExecuteResponse = {
      ...request,
      provider: this.providerName,
      externalReferenceId,
      externalUrl,
      executedAt,
    };
    this.executed.push(record);

    return {
      provider: this.providerName,
      externalReferenceId,
      externalUrl,
      executedAt,
    };
  }
}

export type HttpBusinessAutomationProviderOptions = {
  defaultWebhookUrl?: string | undefined;
  signingSecret?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  dnsLookup?: WebhookDnsLookupFn | undefined;
  maxRedirects?: number | undefined;
  timeoutMs?: number | undefined;
};

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export class HttpBusinessAutomationProvider implements BusinessAutomationProvider {
  readonly providerName = 'http_webhook';
  private readonly defaultWebhookUrl: string | undefined;
  private readonly signingSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly dnsLookup: WebhookDnsLookupFn;
  private readonly maxRedirects: number;
  private readonly timeoutMs: number;

  constructor(options?: HttpBusinessAutomationProviderOptions) {
    this.defaultWebhookUrl = options?.defaultWebhookUrl?.trim() || undefined;
    this.signingSecret = options?.signingSecret?.trim() || undefined;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    this.dnsLookup = options?.dnsLookup ?? defaultWebhookDnsLookup;
    this.maxRedirects = Math.min(Math.max(options?.maxRedirects ?? 3, 0), 5);
    this.timeoutMs = Math.max(options?.timeoutMs ?? 10_000, 50);
  }

  private async validateWebhookDestination(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new AutomationProviderError({
        code: 'provider_not_configured',
        message: 'Outbound automation connector endpoint URL is invalid.',
        retryable: false,
      });
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new AutomationProviderError({
        code: 'provider_not_configured',
        message: 'Outbound automation connector endpoint URL must use HTTPS on a public host.',
        retryable: false,
      });
    }

    if (isForbiddenInternalWebhookHost(parsed.hostname)) {
      throw new AutomationProviderError({
        code: 'provider_not_configured',
        message: 'Outbound automation connector endpoint URL must use HTTPS on a public host.',
        retryable: false,
      });
    }

    if (!isIpLiteralHostname(parsed.hostname)) {
      let resolvedRecords: ReadonlyArray<WebhookDnsLookupRecord>;
      try {
        resolvedRecords = await this.dnsLookup(parsed.hostname);
      } catch {
        throw new AutomationProviderError({
          code: 'provider_not_configured',
          message: 'Outbound automation connector hostname failed server-side DNS resolution.',
          retryable: false,
        });
      }

      if (!Array.isArray(resolvedRecords) || resolvedRecords.length === 0) {
        throw new AutomationProviderError({
          code: 'provider_not_configured',
          message: 'Outbound automation connector hostname did not resolve to any IP address.',
          retryable: false,
        });
      }

      for (const record of resolvedRecords) {
        const addr = typeof record?.address === 'string' ? record.address.trim() : '';
        if (!addr || !isIpLiteralHostname(addr) || isForbiddenInternalWebhookHost(addr)) {
          throw new AutomationProviderError({
            code: 'provider_not_configured',
            message:
              'Outbound automation connector hostname resolved to a prohibited private or internal IP address.',
            retryable: false,
          });
        }
      }
    }

    return parsed;
  }

  async executeAction(request: AutomationExecuteRequest): Promise<AutomationExecuteResponse> {
    const targetUrl = request.endpointUrl?.trim() || this.defaultWebhookUrl;
    if (!targetUrl) {
      throw new AutomationProviderError({
        code: 'provider_not_configured',
        message:
          'Outbound automation connector endpoint URL is not configured for this workspace action.',
        retryable: false,
      });
    }

    const initialParsed = await this.validateWebhookDestination(targetUrl);
    const initialOrigin = initialParsed.origin;

    const bodyJson = JSON.stringify({
      actionId: request.actionId,
      workspaceId: request.workspaceId,
      meetingId: request.meetingId,
      connectorType: request.connectorType,
      actionType: request.actionType,
      idempotencyKey: request.idempotencyKey,
      payloadSha256: request.payloadSha256,
      confirmedBy: request.confirmedBy,
      confirmedAt: request.confirmedAt,
      payload: request.payload,
    });

    const signatureHeader = this.signingSecret
      ? `sha256=${createHmac('sha256', this.signingSecret).update(bodyJson, 'utf8').digest('hex')}`
      : undefined;

    let currentUrl = initialParsed;
    let response: Response | null = null;

    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const sameOrigin = currentUrl.origin === initialOrigin;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort(new Error('webhook_request_timeout'));
      }, this.timeoutMs);

      try {
        response = await this.fetchImpl(currentUrl.toString(), {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': request.idempotencyKey,
            'x-suhbat-workspace-id': request.workspaceId,
            'x-suhbat-meeting-id': request.meetingId,
            'x-suhbat-action-id': request.actionId,
            'x-suhbat-payload-sha256': request.payloadSha256,
            ...(sameOrigin && this.signingSecret
              ? { 'x-suhbat-webhook-secret': this.signingSecret }
              : {}),
            ...(sameOrigin && signatureHeader ? { 'x-suhbat-signature-256': signatureHeader } : {}),
          },
          body: bodyJson,
        });
      } catch {
        throw new AutomationProviderError({
          code: 'provider_unavailable',
          message:
            'External business automation endpoint request failed or timed out due to a network transport error.',
          retryable: true,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!REDIRECT_STATUS_CODES.has(response.status)) {
        break;
      }

      if (redirectCount >= this.maxRedirects) {
        throw new AutomationProviderError({
          code: 'provider_rejected',
          message: 'External business automation endpoint exceeded maximum allowed redirects.',
          retryable: false,
        });
      }

      const locationHeader = response.headers.get('location')?.trim();
      if (!locationHeader) {
        throw new AutomationProviderError({
          code: 'provider_rejected',
          message:
            'External business automation endpoint returned a redirect without a Location header.',
          retryable: false,
        });
      }

      let resolvedNextUrl: string;
      try {
        resolvedNextUrl = new URL(locationHeader, currentUrl.toString()).toString();
      } catch {
        throw new AutomationProviderError({
          code: 'provider_not_configured',
          message: 'Outbound automation connector redirect URL is invalid.',
          retryable: false,
        });
      }

      currentUrl = await this.validateWebhookDestination(resolvedNextUrl);
    }

    if (!response) {
      throw new AutomationProviderError({
        code: 'provider_unavailable',
        message: 'External business automation endpoint returned no response.',
        retryable: true,
      });
    }

    if (response.status === 429) {
      throw new AutomationProviderError({
        code: 'rate_limited',
        message: 'External business automation endpoint rate limit exceeded.',
        retryable: true,
      });
    }

    if (!response.ok) {
      throw new AutomationProviderError({
        code: response.status >= 500 ? 'provider_unavailable' : 'provider_rejected',
        message: `External business automation endpoint returned HTTP ${response.status}.`,
        retryable: response.status >= 500,
      });
    }

    let externalReferenceId = `http_${request.actionId.slice(0, 8)}`;
    let externalUrl: string | null = null;
    try {
      const json = (await response.json()) as {
        id?: string | number;
        externalReferenceId?: string;
        externalUrl?: string;
      };
      if (json.externalReferenceId) externalReferenceId = String(json.externalReferenceId);
      else if (json.id !== undefined) externalReferenceId = String(json.id);
      if (typeof json.externalUrl === 'string' && /^https?:\/\//.test(json.externalUrl)) {
        externalUrl = json.externalUrl;
      }
    } catch {
      // Non-JSON 2xx acknowledgement is acceptable for webhook endpoints
    }

    return {
      provider: this.providerName,
      externalReferenceId,
      externalUrl,
      executedAt: new Date().toISOString(),
    };
  }
}

export function createBusinessAutomationProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): BusinessAutomationProvider {
  const isProd = env.NODE_ENV === 'production';
  const rawMode =
    env.SUHBAT_AUTOMATION_PROVIDER ?? env.AUTOMATION_PROVIDER ?? (isProd ? 'webhook' : 'fake');
  const mode = rawMode.trim().toLowerCase();

  if (mode === 'fake') {
    if (isProd) {
      throw new AutomationProviderError({
        code: 'provider_not_configured',
        message: 'FakeBusinessAutomationProvider is not permitted in production.',
        retryable: false,
      });
    }
    return new FakeBusinessAutomationProvider();
  }

  if (mode === 'http' || mode === 'webhook' || mode === 'live') {
    if (!env.AUTOMATION_WEBHOOK_SECRET?.trim()) {
      throw new AutomationProviderError({
        code: 'provider_not_configured',
        message:
          'Live automation provider requires AUTOMATION_WEBHOOK_SECRET when SUHBAT_AUTOMATION_PROVIDER=http.',
        retryable: false,
      });
    }
    return new HttpBusinessAutomationProvider({
      defaultWebhookUrl: env.AUTOMATION_DEFAULT_WEBHOOK_URL,
      signingSecret: env.AUTOMATION_WEBHOOK_SECRET,
    });
  }

  throw new AutomationProviderError({
    code: 'provider_not_configured',
    message: `Unsupported SUHBAT_AUTOMATION_PROVIDER="${mode}". Expected "fake" or "http".`,
    retryable: false,
  });
}
