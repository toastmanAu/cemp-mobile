/**
 * Background tick branch (Phase 9 design D1).
 *
 * Unlocked: run the whole engine, then refresh the route-tag cache so a later
 * locked probe has current tags even across an epoch boundary.
 *
 * Locked or cold start: probe the cached route tags and post ONE notification
 * naming how many new cells are waiting. It never opens the database and never
 * decrypts — the encryption key does not exist in memory while locked.
 *
 * Every dependency is injected so this file has no React Native import and is
 * unit-tested directly.
 */

import { newOutpoints, type TagCache } from "./platform/route-tag-cache-codec";

export type BackgroundSyncOutcome = "full" | "notified" | "quiet" | "idle";

export interface BackgroundSyncDeps {
  /** True only when the vault key is in memory (app alive and unlocked). */
  isVaultUnlocked(): boolean;
  /** `messaging.syncNow()` — the full worker sweep. */
  runFullSync(): Promise<void>;
  /** Re-derive and persist route tags; requires an unlocked vault. */
  refreshTagCache(): Promise<void>;
  readTagCache(): Promise<TagCache | undefined>;
  writeTagCache(cache: TagCache): Promise<void>;
  /** Outpoints (`txHash:index`) currently on-chain for one hex route tag. */
  listOutpointsForTag(tagHex: string): Promise<string[]>;
  /** Post the single "you have mail" notification. */
  notify(newCount: number): Promise<void>;
}

export async function runBackgroundSync(deps: BackgroundSyncDeps): Promise<BackgroundSyncOutcome> {
  if (deps.isVaultUnlocked()) {
    await deps.runFullSync();
    await deps.refreshTagCache();
    return "full";
  }

  const cache = await deps.readTagCache();
  if (cache === undefined || cache.tags.length === 0) {
    return "idle"; // never unlocked since install — nothing to probe with
  }

  const current: string[] = [];
  let answered = false;
  for (const tag of cache.tags) {
    try {
      current.push(...(await deps.listOutpointsForTag(tag)));
      answered = true;
    } catch {
      // Per-tag isolation: one stale or failing tag must not suppress the
      // healthy ones. Only tags that answered contribute to `lastSeen`.
      continue;
    }
  }
  if (!answered) {
    // Nothing was observed, so recording a sighting would wrongly mark every
    // waiting message as seen. WorkManager retries later.
    return "quiet";
  }

  const unseen = newOutpoints(cache.lastSeen, current);
  if (unseen.length > 0) {
    try {
      // Notify BEFORE recording the sighting: if the notification fails, the
      // next tick must see these outpoints as new again rather than lose them.
      await deps.notify(unseen.length);
    } catch {
      return "quiet";
    }
  }
  await deps.writeTagCache({ tags: cache.tags, lastSeen: current });
  return unseen.length > 0 ? "notified" : "quiet";
}
