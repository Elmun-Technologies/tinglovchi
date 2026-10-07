import { NextResponse, type NextRequest } from 'next/server';
import type { FinalizeRecordingRequestInput } from '@suhbat/contracts';
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
    const body = (await parseJsonBody(request, {
      allowEmpty: true,
    })) as FinalizeRecordingRequestInput;
    const result = await service.finalizeRecording(principal, recordingId, body);
    return NextResponse.json(result, {
      status: result.status === 'finalized' ? 200 : 409,
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
