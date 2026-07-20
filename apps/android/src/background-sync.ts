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
 * Diagnostics only (see task instructions this instrumentation was added
 * for). Every line below is prefixed so it can be grepped out of logcat
 * (`adb logcat | grep CempSync`) alongside the native `CempSync` tag.
 *
 * SECURITY: these lines must never carry message content, contact names,
 * profile ids, route tags, outpoints, or any other identifier — counts and
 * outcomes only. Logcat is world-readable to anyone with adb and ends up in
 * bug reports.
 */
const LOG_TAG = "[CempSync]";

/**
 * The error's CLASS ONLY — never its message.
 *
 * Error text reaching these catches is NOT safe to log. `outpointsForTag` ->
 * `findMessageCells` -> `CempClient` raises `CempCkbError`, whose message is
 * built from `preview()` of raw RPC response data (packages/cemp-ckb/src/client.ts)
 * and clipped at 80 characters — a 32-byte tx hash is 66, so an outpoint tied
 * to the user's own inbox fits comfortably and would reach world-readable
 * logcat. Only our OWN errors carry static messages; these catches see other
 * people's too.
 *
 * The class name alone distinguishes a transport failure from a shape failure
 * from a programming error, which is what triage actually needs from a bug
 * report. `CempCkbError`'s `context` field is deliberately NOT included: it is
 * not exported from the package root, and several of its values interpolate
 * the RPC endpoint URL.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

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
  console.log(`${LOG_TAG} backgroundSyncTask: entered`);

  const cache = createRouteTagCache();
  const notifier = new AndroidNotifier();
  const container = AppContainer.current();
  const unlocked = container?.state === "ready";
  console.log(
    `${LOG_TAG} backgroundSyncTask: vault seen as ${unlocked ? "unlocked" : "locked"}; ` +
      `taking the ${unlocked ? "full-sync" : "locked-probe"} branch`,
  );

  // Counts only, accumulated across the locked-probe loop below — see the
  // SECURITY note on LOG_TAG above.
  let tagsRead = 0;
  let tagsAnswered = 0;
  let outpointsSeen = 0;

  try {
    const outcome = await runBackgroundSync({
      isVaultUnlocked: () => container?.state === "ready",
      runFullSync: async () => {
        console.log(`${LOG_TAG} full sync: starting`);
        await requireMessaging(container).messaging.syncNow();
        console.log(`${LOG_TAG} full sync: completed`);
      },
      refreshTagCache: async () => {
        const ready = requireMessaging(container);
        const tags = await ready.messaging.routeTagsHex();
        await cache.writeTags(tags);
        console.log(`${LOG_TAG} full sync: route-tag cache refreshed (${tags.length} tag(s))`);
      },
      readTagCache: async () => {
        const result = await cache.read();
        tagsRead = result?.tags.length ?? 0;
        console.log(`${LOG_TAG} locked probe: read ${tagsRead} cached route tag(s)`);
        return result;
      },
      writeTagCache: (next) => cache.write(next),
      // Standalone by design: on a cold start there is no container, so this
      // must not depend on one (see Step 2b).
      listOutpointsForTag: async (tagHex) => {
        try {
          const outpoints = await outpointsForTag(tagHex);
          tagsAnswered += 1;
          outpointsSeen += outpoints.length;
          console.log(
            `${LOG_TAG} locked probe: tag ${tagsAnswered}/${tagsRead} answered with ` +
              `${outpoints.length} outpoint(s)`,
          );
          return outpoints;
        } catch (error) {
          // Rethrown unchanged — background-sync-core.ts owns per-tag
          // isolation (one failing tag must not suppress the others). This
          // only logs before letting that catch run.
          console.warn(`${LOG_TAG} locked probe: tag query failed — ${describeError(error)}`);
          throw error;
        }
      },
      notify: async (count) => {
        console.log(`${LOG_TAG} locked probe: posting notification for ${count} new message(s)`);
        try {
          await notifier.post({
            id: "locked-inbox",
            channel: "messages",
            title: "CellSend",
            body: `${String(count)} new message${count === 1 ? "" : "s"} — unlock to read`,
          });
          console.log(`${LOG_TAG} locked probe: notification posted`);
        } catch (error) {
          // Rethrown unchanged — background-sync-core.ts treats a failed
          // notify as "quiet" so the same outpoints are retried next tick.
          console.warn(`${LOG_TAG} locked probe: notify failed — ${describeError(error)}`);
          throw error;
        }
      },
    });
    console.log(
      `${LOG_TAG} backgroundSyncTask: outcome=${outcome}` +
        (unlocked
          ? ""
          : ` tagsRead=${tagsRead} tagsAnswered=${tagsAnswered} outpointsSeen=${outpointsSeen}`),
    );
  } catch (error) {
    // `requireMessaging` above already did its job by this point: the
    // degraded tick never ran a real sync or wrote fresh tags, so it cannot
    // be mistaken for a successful one. This catch exists only to end the
    // headless task promptly (see `requireMessaging`'s doc comment) — there
    // is no `HeadlessJsTaskError` import available here (React Native does
    // not export one publicly), so swallowing after logging is the boundary
    // fix rather than rethrowing a typed error the native side would notice.
    console.error(`${LOG_TAG} backgroundSyncTask: degraded tick — ${describeError(error)}`);
  }
}
