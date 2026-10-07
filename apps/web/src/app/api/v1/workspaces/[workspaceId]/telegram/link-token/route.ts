import { NextResponse, type NextRequest } from 'next/server';
import type { CreateTelegramLinkTokenRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  try {
    const { workspaceId } = await context.params;
    const { phase8Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request, {
      allowEmpty: true,
    })) as CreateTelegramLinkTokenRequestInput;
    const result = await phase8Service.createLinkToken(principal, workspaceId, body);
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
