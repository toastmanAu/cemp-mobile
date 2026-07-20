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
 * Throwing is still the right shape: it is what stops `runBackgroundSync`
 * from resolving as if a degraded tick had done real work. It is NOT a retry
 * mechanism, though, and must not be described as one:
 *
 * - React Native 0.83's `AppRegistryImpl.startHeadlessTask` (in
 *   `node_modules`) only calls `notifyTaskRetry`/`notifyTaskFinished` when
 *   the rejection is `instanceof HeadlessJsTaskError`; a plain `Error` is
 *   just `console.error`'d and the task is never marked finished.
 * - `CempSyncWorker.doWork()` (android/app/.../background/CempSyncWorker.kt)
 *   waits for that finish notification, so an uncaught rejection here would
 *   leave the worker suspended until `TASK_TIMEOUT_MS` (120s) expires. That
 *   does eventually surface as `Result.retry()`, but only after burning the
 *   full timeout — it is a wedged-runtime backstop, not a retry mechanism to
 *   design against.
 *
 * `backgroundSyncTask` below catches this itself precisely so the task ends
 * promptly instead of lingering for that 120s — see the comment there.
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

  try {
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
  } catch (error) {
    // `requireMessaging` above already did its job by this point: the
    // degraded tick never ran a real sync or wrote fresh tags, so it cannot
    // be mistaken for a successful one. This catch exists only to end the
    // headless task promptly (see `requireMessaging`'s doc comment) — there
    // is no `HeadlessJsTaskError` import available here (React Native does
    // not export one publicly), so swallowing after logging is the boundary
    // fix rather than rethrowing a typed error the native side would notice.
    console.error("backgroundSyncTask: degraded tick", error);
  }
}
