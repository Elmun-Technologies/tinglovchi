import { NextResponse, type NextRequest } from 'next/server';
import type { CreateMeetingExportRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
): Promise<NextResponse> {
  try {
    const { meetingId } = await context.params;
    const { phase9Service, principal } = await resolveApiContext(request);
    const workspaceId = request.nextUrl.searchParams.get('workspaceId') ?? undefined;
    const result = await phase9Service.listMeetingAutomations(principal, meetingId, workspaceId);
    return NextResponse.json(
      {
        meetingId: result.meetingId,
        workspaceId: result.workspaceId,
        exports: result.exports,
      },
      { status: 200 },
    );
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
): Promise<NextResponse> {
  try {
    const { meetingId } = await context.params;
    const { phase9Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request, {
      allowEmpty: true,
    })) as CreateMeetingExportRequestInput;
    const result = await phase9Service.createMeetingExport(principal, meetingId, body);
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
