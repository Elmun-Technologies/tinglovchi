import { NextResponse, type NextRequest } from 'next/server';
import type { AuthorizeChunkUploadRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string; chunkId: string }> },
) {
  try {
    const { service, principal } = await resolveApiContext(request);
    const { recordingId, chunkId } = await context.params;
    const body = (await parseJsonBody(request, {
      allowEmpty: true,
    })) as AuthorizeChunkUploadRequestInput;
    const result = await service.authorizeChunkUpload(principal, recordingId, chunkId, body);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
