import { NextResponse, type NextRequest } from 'next/server';
import type { RegisterRecordingChunkRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { service, principal } = await resolveApiContext(request);
    const { recordingId } = await context.params;
    const body = (await parseJsonBody(request)) as RegisterRecordingChunkRequestInput;
    const result = await service.registerChunk(principal, recordingId, body);
    return NextResponse.json(result, {
      status: result.idempotentReused ? 200 : 201,
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
