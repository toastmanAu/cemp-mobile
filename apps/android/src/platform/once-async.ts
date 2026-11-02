/**
 * Memoise an async initialiser for the life of the JS runtime: concurrent and
 * later callers share one result; a rejection is forgotten so a retry can
 * succeed. Pure (no react-native import), so it runs under vitest.
 */
export function onceAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending === null) {
      pending = factory().catch((e: unknown) => {
        pending = null;
        throw e;
      });
    }
    return pending;
  };
}
