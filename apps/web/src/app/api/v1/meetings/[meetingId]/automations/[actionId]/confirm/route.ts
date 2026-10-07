import { NextResponse, type NextRequest } from 'next/server';
import type { ConfirmAutomationActionRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string; actionId: string }> },
): Promise<NextResponse> {
  try {
    const { meetingId, actionId } = await context.params;
    const { phase9Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request)) as ConfirmAutomationActionRequestInput;
    const result = await phase9Service.confirmAutomationAction(
      principal,
      meetingId,
      actionId,
      body,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string; actionId: string }> },
): Promise<NextResponse> {
  try {
    const { meetingId, actionId } = await context.params;
    const { phase9Service, principal } = await resolveApiContext(request);
    const workspaceId = request.nextUrl.searchParams.get('workspaceId') ?? undefined;
    const action = await phase9Service.cancelAutomationAction(principal, meetingId, actionId, {
      ...(workspaceId ? { workspaceId } : {}),
    });
    return NextResponse.json({ action }, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
