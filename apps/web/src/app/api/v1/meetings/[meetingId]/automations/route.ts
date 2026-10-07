import { NextResponse, type NextRequest } from 'next/server';
import type { PrepareAutomationActionRequestInput } from '@suhbat/contracts';
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
    return NextResponse.json(result, { status: 200 });
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
    const body = (await parseJsonBody(request)) as PrepareAutomationActionRequestInput;
    const result = await phase9Service.prepareAutomationAction(principal, meetingId, body);
    return NextResponse.json(result, { status: result.idempotentReused ? 200 : 201 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
