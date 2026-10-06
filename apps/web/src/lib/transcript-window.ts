/**
 * Paging values as they arrive in the address bar.
 *
 * The transcript screen reads `?offset=` and `?span=` straight from a URL, so before they reach the repository
 * they are coerced to whole, non-negative numbers — or dropped, which lets the adapter apply its own default and
 * its own ceiling. A page must not be able to ask for `?span=1e9` and pull a whole three-hour meeting into one
 * response by accident, and `?offset=-40` must not become a negative slice index.
 */
export type TranscriptPagingQuery = {
  offset?: number;
  span?: number;
};

/** `NaN`, negatives, fractions and empty values are all "the reader did not ask for this". */
function wholePositive(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

export function transcriptPagingFromQuery(query: {
  offset?: string;
  span?: string;
}): TranscriptPagingQuery {
  return {
    offset: wholePositive(query.offset),
    span: wholePositive(query.span),
  };
}

/** Offset aligned down to a whole page, so "previous" from a mid-page link cannot land on a partial window. */
export function floorToPage(offset: number, span: number): number {
  return span > 0 ? Math.floor(offset / span) * span : 0;
}
