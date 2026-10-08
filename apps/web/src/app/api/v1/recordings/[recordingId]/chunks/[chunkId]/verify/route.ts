import type { NextRequest } from 'next/server';
import { resolveRecordingContext } from '../../../../../../../../lib/recording-gateway';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recordingId: string; chunkId: string }> },
) {
  try {
    const { recordingId, chunkId } = await context.params;
    const gateway = await resolveRecordingContext(request);
    return await gateway.forward({
      path: `/api/v1/recordings/${encodeURIComponent(recordingId)}/chunks/${encodeURIComponent(chunkId)}/verify`,
      method: 'POST',
      body: await request.text(),
    });
  } catch (cause) {
    const { handleApiError } = await import('../../../../../../../../lib/api-v1-runtime');
    return handleApiError(cause);
  }
}
