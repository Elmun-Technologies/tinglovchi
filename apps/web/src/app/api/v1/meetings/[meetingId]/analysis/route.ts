import { NextResponse, type NextRequest } from 'next/server';
import { handleApiError, resolveApiContext } from '../../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
) {
  try {
    const { phase6Service, principal } = await resolveApiContext(request);
    const { meetingId } = await context.params;
    const workspaceId = request.nextUrl?.searchParams.get('workspaceId') ?? undefined;
    const result = await phase6Service.getMeetingAnalysisStatus(principal, meetingId, workspaceId);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
