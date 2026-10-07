import { NextResponse, type NextRequest } from 'next/server';
import { handleApiError, resolveApiContext } from '../../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
) {
  try {
    const { phase5Service, principal } = await resolveApiContext(request);
    const { meetingId } = await context.params;
    const searchParams = request.nextUrl?.searchParams;
    const workspaceId = searchParams?.get('workspaceId') ?? undefined;
    const speaker = searchParams?.get('speaker') ?? undefined;
    const query = searchParams?.get('query') ?? searchParams?.get('q') ?? undefined;
    const limitParam = searchParams?.get('limit');
    const offsetParam = searchParams?.get('offset');
    const limit =
      limitParam !== null && limitParam !== undefined && limitParam !== ''
        ? Number.parseInt(limitParam, 10)
        : undefined;
    const offset =
      offsetParam !== null && offsetParam !== undefined && offsetParam !== ''
        ? Number.parseInt(offsetParam, 10)
        : undefined;

    const result = await phase5Service.getMeetingTranscript(principal, meetingId, {
      clientWorkspaceId: workspaceId,
      speaker,
      query,
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
