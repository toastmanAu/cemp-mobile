/**
 * A minimal async mutex: serializes callers onto a single promise chain so
 * only one holds the lock at a time.
 *
 * Used by the SQLite adapters (node.ts, apps/android's sqlcipher-adapter.ts)
 * to serialize `transaction()` calls across one shared connection. Two
 * concurrent callers must never both issue `BEGIN IMMEDIATE` on the same
 * connection — the mutex queues the second until the first's
 * commit/rollback has released the lock, and each caller still runs its own
 * independent transaction (concurrent callers are never merged into one).
 *
 * NOT reentrant: calling `runExclusive` again from inside a held lock's
 * callback (on the same instance) deadlocks — the inner call waits for the
 * outer to release, but the outer is waiting on the inner to finish.
 */
export class AsyncMutex {
  #queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      // Always release, even on failure — a rejected fn() must not wedge
      // the queue for the next caller.
      release();
    }
  }
}
