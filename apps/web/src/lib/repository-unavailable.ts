import { RepositoryError } from '@suhbat/product';

/**
 * One proxy per repository namespace: every method rejects with an explicit, typed error.
 *
 * Shared by the Supabase session adapter and the SQL/worker-side adapter. A namespace with no live
 * implementation must say so instead of quietly returning fixtures or inventing empty data.
 */
export function unavailableNamespace(
  name: string,
  message: string,
  code: RepositoryError['code'] = 'provider_unavailable',
): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return () =>
          Promise.reject(
            new RepositoryError(code, message, {
              detail: `${name}.${property}`,
              hint: 'Report this screen: it is reachable but has no repository implementation in live mode.',
            }),
          );
      },
    },
  );
}
