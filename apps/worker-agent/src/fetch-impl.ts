/**
 * Workers-safe fetch: never call global `fetch` as `obj.fetchImpl(...)` —
 * that rebinds `this` and throws Illegal invocation.
 */
export function resolveFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) {
    return fetchImpl;
  }
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch;
}
