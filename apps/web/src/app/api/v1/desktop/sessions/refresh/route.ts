import { NextResponse, type NextRequest } from 'next/server';
import {
  refreshDesktopSessionRequestSchema,
  refreshDesktopSessionResponseSchema,
} from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveDesktopContext,
} from '../../../../../../lib/api-v1-runtime';

/**
 * `POST /api/v1/desktop/sessions/refresh` — trade a rotating refresh token for a fresh credential pair.
 *
 * This is the only endpoint that accepts a refresh token, which is what makes the split worthwhile:
 * the long-lived credential is never sent to an ordinary data endpoint, so a compromised request log
 * or a captured call yields at most fifteen minutes of access.
 *
 * The presented refresh token stops working the moment this succeeds. A caller that loses the
 * response can retry once inside a short grace window; anything later is treated as a replay and
 * revokes the whole session.
 *
 * Deliberately reachable without any provider configuration: refreshing must work even when
 * AssemblyAI, OpenAI, or R2 are unset, because being unable to refresh means being unable to upload
 * the meeting the user already recorded.
 */
export async function POST(request: NextRequest) {
  try {
    const { desktopService } = await resolveDesktopContext(request);
    const parsed = refreshDesktopSessionRequestSchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'validation_failed',
            message: parsed.error.issues[0]?.message ?? 'A refresh token is required.',
          },
        },
        { status: 400 },
      );
    }

    const result = await desktopService.refreshSession(parsed.data.refreshToken);
    return NextResponse.json(refreshDesktopSessionResponseSchema.parse(result), {
      status: 200,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
