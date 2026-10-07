import { NextResponse, type NextRequest } from 'next/server';
import type { AskWorkspaceQuestionRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase7Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request)) as AskWorkspaceQuestionRequestInput;
    const result = await phase7Service.askWorkspaceQuestion(principal, workspaceId, body);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
