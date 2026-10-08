import { NextResponse, type NextRequest } from 'next/server';
import {
  desktopSessionResponseSchema,
  exchangeDesktopSessionRequestSchema,
  type ExchangeDesktopSessionRequestInput,
} from '@suhbat/contracts';
import {
  desktopBearerToken,
  handleApiError,
  parseJsonBody,
  resolveDesktopContext,
} from '../../../../../lib/api-v1-runtime';

/**
 * `POST /api/v1/desktop/sessions` — exchange an approved connect code for a desktop session.
 *
 * The code burns on success: it can never mint a second session. The returned token is the only copy
 * that will ever exist (the server stores a SHA-256), so the response is `private, no-store`.
 */
export async function POST(request: NextRequest) {
  try {
    const { desktopService } = await resolveDesktopContext(request);
    const body = (await parseJsonBody(request)) as ExchangeDesktopSessionRequestInput;
    const parsed = exchangeDesktopSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'validation_failed',
            message: parsed.error.issues[0]?.message ?? 'Invalid desktop session exchange request.',
          },
        },
        { status: 400 },
      );
    }
    const result = await desktopService.exchangeConnectCode(parsed.data);
    const payload = desktopSessionResponseSchema.parse(result);
    return NextResponse.json(payload, {
      status: 201,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}

/**
 * `GET /api/v1/desktop/session` — who am I and which workspace should the recorder preselect.
 *
 * Authenticated with the desktop session token. Runs the same membership check as the web dashboard,
 * so a revoked membership disappears here immediately.
 */
export async function GET(request: NextRequest) {
  try {
    const { desktopService, principal } = await resolveDesktopContext(request);
    const token = desktopBearerToken(request);
    const result = await desktopService.describeSession(principal, token);
    return NextResponse.json(result, {
      status: 200,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}

/**
 * `DELETE /api/v1/desktop/session` — revoke this device's session immediately.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { desktopService } = await resolveDesktopContext(request);
    const token = desktopBearerToken(request);
    const revoked = await desktopService.revokeSessionToken(token);
    return NextResponse.json({ revoked: true as const, hadSession: revoked }, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
