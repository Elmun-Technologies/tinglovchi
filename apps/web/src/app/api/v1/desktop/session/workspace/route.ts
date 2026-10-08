import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  desktopBearerToken,
  handleApiError,
  parseJsonBody,
  resolveDesktopContext,
} from '../../../../../../lib/api-v1-runtime';

const bodySchema = z.object({ workspaceId: z.string().uuid() });

/**
 * `POST /api/v1/desktop/session/workspace` — remember which workspace this device records into.
 *
 * Membership is re-checked on every call, so a stale local choice can never widen access; it only
 * decides what the recorder preselects next time.
 */
export async function POST(request: NextRequest) {
  try {
    const { desktopService, principal } = await resolveDesktopContext(request);
    const parsed = bodySchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'validation_failed', message: 'A workspace UUID is required.' } },
        { status: 400 },
      );
    }
    await desktopService.rememberWorkspace(
      principal,
      desktopBearerToken(request),
      parsed.data.workspaceId,
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
