/**
 * HeadlessJS entry for the WorkManager tick (Phase 9).
 *
 * Thin by design: it builds the real dependencies and hands off to
 * {@link runBackgroundSync}, which holds the branch logic and is unit-tested.
 */

import { AppContainer } from "./app-container";
import { runBackgroundSync } from "./background-sync-core";
import { AndroidNotifier } from "./platform/android-notifier";
import { notifyTaskFinished } from "./platform/headless-task";
import { tickIdFrom } from "./platform/headless-task-id";
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
 * mechanism, though, and must not be described as one — React Native 0.83's
 * `AppRegistryImpl.startHeadlessTask` only reaches `notifyTaskRetry` when the
 * rejection is `instanceof HeadlessJsTaskError`, and RN does not export one
 * publicly.
 *
 * Ending the tick promptly is handled separately and unconditionally, by the
 * `finally` in `backgroundSyncTask` below.
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

/**
 * The HeadlessJS entry point React Native invokes each tick.
 *
 * Wraps {@link runTick} solely to guarantee the native side learns the tick is
 * over — on success and on failure alike — so the JS runtime is released in
 * seconds instead of being held for the full 120s native task timeout. That
 * timeout stays in place as a backstop for a genuinely wedged runtime.
 *
 * `data` is the payload `CempSyncWorker` built; it carries only a tick id.
 */
export async function backgroundSyncTask(data?: unknown): Promise<void> {
  const tickId = tickIdFrom(data);
  try {
    await runTick();
  } finally {
    if (tickId === null) {
      // Nothing to signal against — the tick will linger until the native
      // timeout. Worth a line: it means the payload contract has drifted.
      console.warn(
        `${LOG_TAG} backgroundSyncTask: no tick id in the payload; cannot signal finish`,
      );
    } else {
      notifyTaskFinished(tickId);
      console.log(`${LOG_TAG} backgroundSyncTask: signalled native task finish`);
    }
  }
}

async function runTick(): Promise<void> {
  console.log(`${LOG_TAG} backgroundSyncTask: entered`);

  const cache = createRouteTagCache();
  const notifier = new AndroidNotifier();
  const container = AppContainer.current();

  // Before branching, make the container's cached state agree with the vault's
  // real one. `AppContainer.state` is maintained by a 1-second `setInterval`
  // and the vault auto-locks from a `setTimeout`; React Native freezes both
  // while the app is backgrounded, so on a woken runtime the projection can
  // still read "ready" long after the vault's inactivity deadline passed.
  // Trusting it routed a locked vault into the full-sync branch, and the
  // resumed poll then closed the database out from under that sync.
  await container?.reconcileVaultState();

  const unlocked = container?.vaultUsable === true;
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
      // Re-read rather than reusing `unlocked`: the core owns the branch, and
      // the authoritative reading can change between here and its call.
      isVaultUnlocked: () => container?.vaultUsable === true,
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
