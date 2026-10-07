import { NextResponse, type NextRequest } from 'next/server';
import type { UpsertWorkspaceConnectorRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../../lib/api-v1-runtime';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase9Service, principal } = await resolveApiContext(request);
    const result = await phase9Service.listWorkspaceConnectors(principal, workspaceId);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase9Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request)) as UpsertWorkspaceConnectorRequestInput;
    const connector = await phase9Service.upsertWorkspaceConnector(principal, workspaceId, body);
    return NextResponse.json({ connector }, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
