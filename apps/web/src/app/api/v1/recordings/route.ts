import { NextResponse, type NextRequest } from 'next/server';
import { resolveRecordingContext } from '../../../../lib/recording-gateway';

/**
 * `POST /api/v1/recordings` — register a recording session.
 *
 * This route is a gateway. The write happens in the private Recording API, which holds the
 * privileged database credential this deployment is forbidden from holding. Authentication happens
 * here; authorization is re-checked there.
 */
export async function POST(request: NextRequest) {
  try {
    const context = await resolveRecordingContext(request);
    return await context.forward({
      path: '/api/v1/recordings',
      method: 'POST',
      body: await request.text(),
    });
  } catch (cause) {
    const { handleApiError } = await import('../../../../lib/api-v1-runtime');
    return handleApiError(cause);
  }
}
