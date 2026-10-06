import { Notice } from '@suhbat/ui';
import { readFlash } from '../../lib/feedback';

/**
 * The one way a page shows what a write did.
 *
 * Success and refusal are the same component on purpose: a form that showed a green banner in one place and a
 * plain sentence in another would make the reader guess which screens were trustworthy. The message comes from
 * the redirect's `notice` code, so it survives a reload and can be linked, and `reason` is the adapter's own
 * explanation of a refusal — not a generic "something went wrong".
 */
export function FlashNotice({
  params,
  className = '',
}: {
  params: Record<string, string | string[] | undefined>;
  className?: string;
}) {
  const flash = readFlash(params);
  if (!flash) return null;
  return (
    <div className={className}>
      <Notice tone={flash.tone} title={flash.title}>
        {flash.body}
      </Notice>
    </div>
  );
}
