import { NextResponse, type NextRequest } from 'next/server';
import {
  createMeetingRequestSchema,
  createMeetingResponseSchema,
  type CreateMeetingRequestInput,
} from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../lib/api-v1-runtime';

/**
 * `POST /api/v1/meetings` — create the meeting container a one-tap recording attaches to.
 *
 * The whole point of this endpoint is that it refuses to make the user fill in a form. Only
 * `workspaceId` is required:
 *
 * * no `title`           → `Suhbat — 8 Oct, 14:32`
 * * no `meetingTypeId`   → the workspace's own default type (lowest active sort order)
 * * no company/project   → both stay `null`, editable later from the dashboard
 *
 * Company and project are accepted but must belong to the same workspace; the composite foreign keys
 * in `public.meetings` enforce that even if this check were removed.
 */
export async function POST(request: NextRequest) {
  try {
    const { desktopService, principal } = await resolveApiContext(request);
    const body = (await parseJsonBody(request)) as CreateMeetingRequestInput;
    const parsed = createMeetingRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'validation_failed',
            message: parsed.error.issues[0]?.message ?? 'Invalid meeting creation request.',
          },
        },
        { status: 400 },
      );
    }
    const result = await desktopService.ensureMeeting(principal, parsed.data);
    return NextResponse.json(createMeetingResponseSchema.parse(result), { status: 201 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
