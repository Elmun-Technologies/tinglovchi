import {
  RepositoryError,
  disabledWriteActions,
  type DataCapabilities,
  type ProductRepositories,
} from '@suhbat/product';

/**
 * The seam where a real Supabase/API adapter will be plugged in.
 *
 * It is a real module rather than a TODO comment because the alternative — pages that quietly fall back to
 * demo fixtures in a live deployment — is how a product ends up trusting fabricated data. Every read here
 * rejects with a typed, actionable error, and the UI renders it as a failure state, not as emptiness.
 */

export const liveCapabilities: DataCapabilities = {
  mode: 'live',
  reads: 'live',
  writes: false,
  pipeline: 'none',
  demoStateTransitions: false,
  playback: 'none',
  // No action is enabled, because there is nothing to write to yet. `can()` in every form therefore renders
  // the disabled control with an explanation rather than a button that would reject on submit.
  actions: disabledWriteActions,
  persistence: 'none',
  persistenceLabel: 'This build has no live write path; nothing typed here is saved anywhere.',
  provenanceLabel:
    'Live mode was requested, but this build has no Supabase product adapter yet — see apps/web/src/lib/live-repositories.ts.',
};

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new RepositoryError(
      'provider_unavailable',
      'The live data adapter for this screen is not implemented in this build.',
      {
        detail: method,
        hint: 'Implement ProductRepositories in apps/web/src/lib/live-repositories.ts, or run with SUHBAT_DATA_MODE=demo to review the product surface on typed fixtures.',
      },
    ),
  );
}

/** One proxy per repository namespace: any property access yields a rejecting method. */
function namespace(name: string): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return () => notImplemented(`${name}.${property}`);
      },
    },
  );
}

export function createLivePlaceholderRepositories(): ProductRepositories {
  const namespaces = new Map<string, object>();
  return new Proxy({ capabilities: liveCapabilities } as ProductRepositories, {
    get(target, property) {
      if (property === 'capabilities') return target.capabilities;
      if (typeof property !== 'string') return undefined;
      const existing = namespaces.get(property);
      if (existing) return existing;
      const created = namespace(property);
      namespaces.set(property, created);
      return created;
    },
  });
}
