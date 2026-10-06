'use client';

import { Button } from '@suhbat/ui';

/**
 * The only script on the print view: hand the document to the browser's own print dialog.
 *
 * `window.print()` is the whole feature — the layout, page breaks and what is hidden are all CSS. A server
 * component cannot call it, and pretending otherwise would mean a button that only looks alive.
 */
export function PrintButton({ label = 'Print' }: { label?: string }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => window.print()}
      className="print:hidden"
    >
      {label}
    </Button>
  );
}
