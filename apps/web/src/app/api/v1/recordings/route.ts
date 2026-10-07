import { NextResponse, type NextRequest } from 'next/server';
import type { CreateRecordingRequestInput } from '@suhbat/contracts';
import { handleApiError, parseJsonBody, resolveApiContext } from '../../../../lib/api-v1-runtime';

export async function POST(request: NextRequest) {
  try {
    const { service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request)) as CreateRecordingRequestInput;
    const result = await service.createRecording(principal, body);
    return NextResponse.json(result, {
      status: result.idempotentReused ? 200 : 201,
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
