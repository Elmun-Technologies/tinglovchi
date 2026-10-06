import { buildMeetingExport, exportFormats, routes } from '@suhbat/product';
import { getRepositories } from '../../../../../../lib/repositories';
import {
  attachmentDisposition,
  loadExportInput,
  parseExportFormat,
  transcriptRequested,
} from '../../../../../../lib/export-input';

/**
 * The download endpoint for one meeting.
 *
 * A file is a resource of its own, so it gets a URL: it can be opened in a new tab, bookmarked, and (later)
 * authorised separately from the app shell. Two rules keep it honest. The body is built by `@suhbat/product`
 * from the same records the screens render — no second implementation of "what an export contains". And a
 * failure does not return a half-written file: it redirects back to the meeting with the reason, because a
 * downloaded empty document would look like success.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; meetingId: string }> },
): Promise<Response> {
  const { workspaceId, meetingId } = await context.params;
  const url = new URL(request.url);
  const requested = url.searchParams.get('format') ?? 'md';
  const format = parseExportFormat(requested);
  const includeTranscript = transcriptRequested(url.searchParams.get('transcript'));

  if (!format)
    return new Response(`Unknown export format "${requested}". Try: ${exportFormats.join(', ')}.`, {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

  const loaded = await loadExportInput(getRepositories(), workspaceId, meetingId, {
    includeTranscript,
  });
  if (!loaded.ok) {
    // Back to the meeting with the code and the reason, where the reader can see what is missing.
    const target = new URL(routes.meeting({ workspaceId, meetingId }), url);
    target.searchParams.set('notice', `error:${loaded.error.code}`);
    if (loaded.error.message.length <= 300) target.searchParams.set('reason', loaded.error.message);
    return Response.redirect(target, 303);
  }

  const document = buildMeetingExport(loaded.input, format);
  return new Response(document.body, {
    status: 200,
    headers: {
      'content-type': `${document.mediaType}; charset=utf-8`,
      'content-disposition': attachmentDisposition(document.filename),
      // Derived from records that a reload could change; never cache a file the reader might act on.
      'cache-control': 'no-store',
    },
  });
}
