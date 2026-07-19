/**
 * HeadlessJS entry for the WorkManager tick (Phase 9).
 *
 * Thin by design: it builds the real dependencies and hands off to
 * {@link runBackgroundSync}, which holds the branch logic and is unit-tested.
 */

import { AppContainer } from "./app-container";
import { runBackgroundSync } from "./background-sync-core";
import { AndroidNotifier } from "./platform/android-notifier";
import { AndroidKeychainKeyStore } from "./platform/android-keystore";
import { outpointsForTag } from "./platform/locked-probe";
import { RouteTagCache } from "./platform/route-tag-cache";

export async function backgroundSyncTask(): Promise<void> {
  const cache = new RouteTagCache(new AndroidKeychainKeyStore());
  const notifier = new AndroidNotifier();
  const container = AppContainer.current();

  await runBackgroundSync({
    isVaultUnlocked: () => container?.state === "ready",
    runFullSync: async () => {
      if (container?.hasMessaging === true) {
        await container.messaging.syncNow();
      }
    },
    refreshTagCache: async () => {
      if (container?.hasMessaging !== true) {
        return;
      }
      await cache.writeTags(await container.messaging.routeTagsHex());
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
