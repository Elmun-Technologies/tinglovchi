import { NextResponse, type NextRequest } from 'next/server';
import { handleApiError, resolveApiContext } from '../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { service, principal } = await resolveApiContext(request);
    const { recordingId } = await context.params;
    const workspaceId = request.nextUrl?.searchParams.get('workspaceId') ?? undefined;
    const result = await service.getRecording(principal, recordingId, workspaceId);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { service, principal } = await resolveApiContext(request);
    const { recordingId } = await context.params;
    const workspaceId = request.nextUrl?.searchParams.get('workspaceId') ?? undefined;
    const result = await service.deleteRecording(principal, recordingId, workspaceId);
    return NextResponse.json(result, {
      status: result.status === 'deleted' ? 200 : 202,
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
