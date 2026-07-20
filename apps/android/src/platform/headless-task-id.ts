/**
 * Reads the native tick correlation id out of a headless task payload.
 *
 * React Native hands the task provider whatever `WritableMap` the native side
 * built, so this is an untrusted boundary as far as types go — hence the
 * validation rather than a cast. Deliberately free of any `react-native`
 * import so it can be unit-tested (project rule: RN importers cannot run under
 * vitest).
 *
 * The id is a process-local counter minted by `CempSyncWorker`; it identifies a
 * tick, never an identity, a contact, or a route tag.
 */
export function tickIdFrom(data: unknown): number | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const value = (data as { tickId?: unknown }).tickId;
  // Tick ids come from AtomicInteger.incrementAndGet(), so they start at 1.
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
