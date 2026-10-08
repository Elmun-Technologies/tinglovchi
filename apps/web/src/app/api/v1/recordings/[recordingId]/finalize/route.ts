import type { NextRequest } from 'next/server';
import { resolveRecordingContext } from '../../../../../../lib/recording-gateway';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string }> },
) {
  try {
    const { recordingId } = await context.params;
    const gateway = await resolveRecordingContext(request);
    return await gateway.forward({
      path: `/api/v1/recordings/${encodeURIComponent(recordingId)}/finalize`,
      method: 'POST',
      body: await request.text(),
    });
  } catch (cause) {
    const { handleApiError } = await import('../../../../../../lib/api-v1-runtime');
    return handleApiError(cause);
  }
}
