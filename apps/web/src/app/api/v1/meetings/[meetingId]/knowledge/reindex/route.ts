import { NextResponse, type NextRequest } from 'next/server';
import type { ReindexKnowledgeRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
): Promise<NextResponse> {
  try {
    const { meetingId } = await context.params;
    const { phase7Service, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request, {
      allowEmpty: true,
    })) as ReindexKnowledgeRequestInput;
    const result = await phase7Service.reindexMeetingKnowledge(principal, meetingId, body);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
