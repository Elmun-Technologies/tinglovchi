import { NextResponse, type NextRequest } from 'next/server';
import type { RetryAnalysisRequestInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../../../lib/api-v1-runtime';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ meetingId: string }> },
) {
  try {
    const { phase6Service, principal } = await resolveApiContext(request);
    const { meetingId } = await context.params;
    const body = (await parseJsonBody(request, {
      allowEmpty: true,
    })) as RetryAnalysisRequestInput;
    const result = await phase6Service.retryAnalysis(principal, meetingId, body);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
