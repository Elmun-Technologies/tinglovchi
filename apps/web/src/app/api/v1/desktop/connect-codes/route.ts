import { NextResponse, type NextRequest } from 'next/server';
import type { CreateDesktopConnectCodeRequestInput } from '@suhbat/contracts';
import {
  desktopConnectCodeHeader,
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../lib/api-v1-runtime';

/**
 * `POST /api/v1/desktop/connect-codes` — mint a short-lived pairing code.
 *
 * Unauthenticated on purpose: the desktop has no credential yet, which is exactly why it is asking.
 * The code is high entropy, expires in ten minutes, is single use, and does nothing until a signed-in
 * human approves it at `/desktop/connect`. Only its SHA-256 is stored.
 *
 * The body is optional, so a plain `POST` with no body works.
 */
export async function POST(request: NextRequest) {
  try {
    const { desktopService } = await resolveApiContext(request);
    const body = (await parseJsonBody(request, { allowEmpty: true })) as
      | CreateDesktopConnectCodeRequestInput
      | Record<string, never>;
    const clientLabel =
      body && typeof body === 'object' && 'clientLabel' in body
        ? typeof body.clientLabel === 'string'
          ? body.clientLabel
          : undefined
        : undefined;
    const result = await desktopService.createConnectCode({ clientLabel });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return handleApiError(cause);
  }
}

/**
 * `GET /api/v1/desktop/connect-codes` — is my pending code approved yet?
 *
 * Read-only and unauthenticated: it answers only with the status of the code supplied in the
 * `Authorization` header, and a wrong or expired code is indistinguishable from a pending one.
 */
export async function GET(request: NextRequest) {
  try {
    const { desktopService } = await resolveApiContext(request);
    const code = desktopConnectCodeHeader(request);
    if (!code) {
      return NextResponse.json(
        { error: { code: 'unauthenticated', message: 'A connect code is required.' } },
        { status: 401 },
      );
    }
    const status = await desktopService.connectCodeStatus(code);
    return NextResponse.json(status, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
