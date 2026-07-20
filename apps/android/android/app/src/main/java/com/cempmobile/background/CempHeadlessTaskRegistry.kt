package com.cempmobile.background

import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Correlates a headless JS task run with the native task id that ends it.
 *
 * React Native 0.83 does not register `HeadlessJsTaskSupportModule` under the
 * New Architecture — `CoreReactPackage` (the bridgeless core module list, in
 * node_modules/react-native/ReactAndroid/.../runtime/CoreReactPackage.kt) simply
 * does not name it, and nothing else in the tree constructs it. So
 * `TurboModuleRegistry.get('HeadlessJsTaskSupport')` resolves to null,
 * `AppRegistryImpl.startHeadlessTask`'s `if (NativeHeadlessJsTaskSupport)`
 * guards all evaluate false, and `notifyTaskFinished` is never called. The only
 * thing that ever finished a task was `HeadlessJsTaskContext`'s own timeout.
 *
 * Rather than depend on that optional module, [CempSyncWorker] mints a **tick
 * id** of its own, passes it to JS in the task payload, and records it here
 * against the real task id. JS calls back through [CempHeadlessTaskModule] with
 * that tick id and this registry finishes the task directly.
 *
 * Ordering: the mapping is published from the same UI-thread runnable that
 * called `startTask`, and `startTask` only *queues* `AppRegistry.startHeadlessTask`
 * onto the JS thread — so the write always happens-before JS can run, let alone
 * call back. (This is the same guarantee `CempSyncWorker` already documents for
 * its `startedTaskId` write.)
 */
internal object CempHeadlessTaskRegistry {

  private class Entry(val reactContext: ReactContext, val taskId: Int)

  private val lastTickId = AtomicInteger(0)
  private val pending = ConcurrentHashMap<Int, Entry>()

  /** A process-unique correlation id. Not derived from anything user-visible. */
  fun nextTickId(): Int = lastTickId.incrementAndGet()

  fun register(tickId: Int, reactContext: ReactContext, taskId: Int) {
    pending[tickId] = Entry(reactContext, taskId)
  }

  /**
   * Drop the mapping without finishing anything. Used by the worker's `finally`
   * so a tick that ended some other way (timeout backstop, thrown start) does
   * not leak an entry — and so a late signal for it is treated as unknown.
   */
  fun forget(tickId: Int) {
    pending.remove(tickId)
  }

  /**
   * Finish the task behind [tickId], exactly once.
   *
   * `ConcurrentHashMap.remove` is atomic, so two concurrent signals cannot both
   * see the entry: the loser gets null and returns false. An unknown or
   * already-finished tick id is therefore a harmless no-op. (`finishTask` is
   * itself idempotent too — it only notifies listeners when the id was still in
   * its active set — so this is belt and braces.)
   *
   * @return true when this call is the one that finished the task.
   */
  fun finish(tickId: Int): Boolean {
    val entry = pending.remove(tickId) ?: return false
    HeadlessJsTaskContext.getInstance(entry.reactContext).finishTask(entry.taskId)
    return true
  }
}
