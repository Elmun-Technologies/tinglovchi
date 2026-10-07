import { NextResponse, type NextRequest } from 'next/server';
import { handleApiError, resolveApiContext } from '../../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
): Promise<NextResponse> {
  try {
    const { meetingId } = await context.params;
    const { phase7Service, principal } = await resolveApiContext(request);
    const clientWorkspaceId = request.nextUrl.searchParams.get('workspaceId') ?? undefined;
    const result = await phase7Service.getMeetingKnowledgeStatus(principal, meetingId, {
      ...(clientWorkspaceId !== undefined ? { clientWorkspaceId } : {}),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
