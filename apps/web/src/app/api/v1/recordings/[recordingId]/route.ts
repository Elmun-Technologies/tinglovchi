import { NextResponse, type NextRequest } from 'next/server';
import { resolveRecordingContext } from '../../../../../lib/recording-gateway';

async function handleApiError(cause: unknown) {
  const { handleApiError: handle } = await import('../../../../../lib/api-v1-runtime');
  return handle(cause);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { recordingId } = await context.params;
    const gateway = await resolveRecordingContext(request);
    return await gateway.forward({
      path: `/api/v1/recordings/${encodeURIComponent(recordingId)}`,
      method: 'GET',
      searchParams: request.nextUrl?.searchParams,
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { recordingId } = await context.params;
    const gateway = await resolveRecordingContext(request);
    return await gateway.forward({
      path: `/api/v1/recordings/${encodeURIComponent(recordingId)}`,
      method: 'DELETE',
      searchParams: request.nextUrl?.searchParams,
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
