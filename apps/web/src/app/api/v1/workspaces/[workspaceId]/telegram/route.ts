import { NextResponse, type NextRequest } from 'next/server';
import type { UpdateTelegramPreferencesRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase8Service, principal } = await resolveApiContext(request);
    const result = await phase8Service.getWorkspaceTelegramStatus(principal, workspaceId);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase8Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request)) as UpdateTelegramPreferencesRequestInput;
    const result = await phase8Service.updatePreferences(principal, workspaceId, body);
    return NextResponse.json({ link: result }, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase8Service, principal } = await resolveApiContext(request);
    const result = await phase8Service.unlinkAccount(principal, workspaceId);
    return NextResponse.json({ link: result }, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
