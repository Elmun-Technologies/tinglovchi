import { NextResponse, type NextRequest } from 'next/server';
import { desktopWorkspaceListResponseSchema } from '@suhbat/contracts';
import { Phase4ServiceError } from '@suhbat/database/phase4';
import { handleApiError, resolveApiContext } from '../../../../lib/api-v1-runtime';

/**
 * `GET /api/v1/workspaces` — every workspace the caller belongs to, in the shape the recorder's
 * switcher renders.
 *
 * Exists so the desktop can refresh its list without re-reading the whole session: a workspace added
 * or revoked in the web dashboard shows up here on the next call, because membership is re-read from
 * the database rather than echoed back from the stored session.
 *
 * The response carries only `id`, `name`, `role`, and the default meeting type — no member lists, no
 * company/project trees, nothing the recorder does not draw.
 */
export async function GET(request: NextRequest) {
  try {
    const { desktopService, principal } = await resolveApiContext(request);
    if (!principal) {
      throw new Phase4ServiceError(
        401,
        'unauthenticated',
        'This session is no longer valid. Sign in again.',
      );
    }
    const workspaces = await desktopService.listWorkspaces(principal.userId);
    return NextResponse.json(desktopWorkspaceListResponseSchema.parse({ workspaces }), {
      status: 200,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (cause) {
    return handleApiError(cause);
  }
}
