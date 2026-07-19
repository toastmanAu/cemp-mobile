/**
 * HeadlessJS entry for the WorkManager tick (Phase 9).
 *
 * Thin by design: it builds the real dependencies and hands off to
 * {@link runBackgroundSync}, which holds the branch logic and is unit-tested.
 */

import { AppContainer } from "./app-container";
import { runBackgroundSync } from "./background-sync-core";
import { AndroidNotifier } from "./platform/android-notifier";
import { outpointsForTag } from "./platform/locked-probe";
import { createRouteTagCache } from "./platform/route-tag-cache";

/**
 * `afterVaultUnlock` deliberately tolerates a `MessagingService.init` failure,
 * so `state === "ready"` with no messaging service is reachable. In that
 * degraded state the full-sync branch must FAIL LOUDLY rather than return
 * normally: a silent no-op would have the core believe a sync ran and tags
 * were refreshed, and the tags would then go stale across an epoch rollover
 * with no signal at all — locked notifications would stop dead.
 *
 * Throwing is the right shape here because the HeadlessJS task's rejection is
 * already the app's error channel for a failed tick: WorkManager retries with
 * backoff, which is exactly the recovery a transient messaging-init failure
 * needs. It also keeps `background-sync-core.ts` untouched.
 */
function requireMessaging(container: AppContainer | null): AppContainer {
  if (container === null || !container.hasMessaging) {
    throw new Error(
      "backgroundSyncTask: the vault reports unlocked but messaging is unavailable — " +
        "the full sync and the route-tag refresh cannot run",
    );
  }
  return container;
}

export async function backgroundSyncTask(): Promise<void> {
  const cache = createRouteTagCache();
  const notifier = new AndroidNotifier();
  const container = AppContainer.current();

  await runBackgroundSync({
    isVaultUnlocked: () => container?.state === "ready",
    runFullSync: async () => {
      await requireMessaging(container).messaging.syncNow();
    },
    refreshTagCache: async () => {
      const ready = requireMessaging(container);
      await cache.writeTags(await ready.messaging.routeTagsHex());
    },
    readTagCache: () => cache.read(),
    writeTagCache: (next) => cache.write(next),
    // Standalone by design: on a cold start there is no container, so this
    // must not depend on one (see Step 2b).
    listOutpointsForTag: (tagHex) => outpointsForTag(tagHex),
    notify: async (count) => {
      await notifier.post({
        id: "locked-inbox",
        channel: "messages",
        title: "CellSend",
        body: `${String(count)} new message${count === 1 ? "" : "s"} — unlock to read`,
      });
    },
  });
}
