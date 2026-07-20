package com.cempmobile.background

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Runs the JS task registered as "CempBackgroundSync" (apps/android/index.js)
 * on each WorkManager tick.
 *
 * There is deliberately no `Service` in this path. A WorkManager periodic
 * worker is *always* in the background, and Android has forbidden background
 * service starts since API 26 — `startService` from here is refused by
 * ActivityManager ("Background start not allowed"), so the previous
 * service-based tick could never run. Instead we drive the JS runtime
 * directly through the app's [ReactHost], which needs no service and shows
 * the user no notification. WorkManager already holds a wake lock for the
 * duration of [doWork], so the device stays awake while the task runs.
 *
 * Phase 9 design D3 still holds: all protocol logic stays in TypeScript. This
 * adapter only boots the runtime and invokes the registered task.
 */
class CempSyncWorker(context: Context, params: WorkerParameters) :
  CoroutineWorker(context, params) {

  override suspend fun doWork(): Result {
    val application = applicationContext
    // `ReactApplication.reactHost` is declared `ReactHost?` and defaults to
    // null; MainApplication overrides it, so null here means a broken build
    // rather than anything a retry could resolve.
    val host = (application as? ReactApplication)?.reactHost
    if (host == null) {
      Log.e(TAG, "No ReactHost on the Application; cannot run the background sync task")
      return Result.failure()
    }

    return try {
      val reactContext = withTimeoutOrNull(CONTEXT_START_TIMEOUT_MS) { awaitReactContext(host) }
      if (reactContext == null) {
        Log.w(TAG, "React context did not start within ${CONTEXT_START_TIMEOUT_MS}ms; retrying")
        return Result.retry()
      }

      val finished = withTimeoutOrNull(TASK_TIMEOUT_MS + TIMEOUT_GRACE_MS) { runTask(reactContext) }
      if (finished == null) {
        // React Native's own TASK_TIMEOUT_MS safeguard should have finished
        // the task well before this; reaching here means the runtime is wedged.
        Log.w(TAG, "Background sync task did not finish within the timeout; retrying")
        Result.retry()
      } else {
        Result.success()
      }
    } catch (error: Exception) {
      // Surface the failure rather than reporting a tick that never ran as a
      // success. Starting the runtime or the task is inherently racy against
      // process teardown, so a retry is the right shape here.
      Log.e(TAG, "Background sync tick failed", error)
      Result.retry()
    }
  }

  /**
   * Returns a live [ReactContext], starting the React instance first if the
   * process cold-started into this worker.
   *
   * `ReactHost.addReactInstanceEventListener` only fires for *future*
   * initialisations, so the already-running case must be handled by reading
   * `currentReactContext` — both before registering (the common case) and
   * again afterwards, to close the window in which the context appears
   * between the two.
   */
  private suspend fun awaitReactContext(host: ReactHost): ReactContext {
    host.currentReactContext?.let { return it }

    val ready = CompletableDeferred<ReactContext>()
    val listener =
      object : ReactInstanceEventListener {
        override fun onReactContextInitialized(context: ReactContext) {
          ready.complete(context)
        }
      }

    host.addReactInstanceEventListener(listener)
    return try {
      host.currentReactContext?.let { ready.complete(it) }
      if (!ready.isCompleted) {
        // ReactHostImpl.start() dispatches onto its own background executor
        // and is safe to call from this (non-main) worker thread.
        host.start()
      }
      ready.await()
    } finally {
      host.removeReactInstanceEventListener(listener)
    }
  }

  /**
   * Starts the headless JS task and suspends until it reports completion, so
   * WorkManager does not tear the work down mid-run.
   *
   * `HeadlessJsTaskContext.startTask` asserts it is on the UI thread, while
   * `doWork` runs on a WorkManager background thread — hence the hop. The
   * task id is published from that same UI-thread runnable and read back in
   * `onHeadlessJsTaskFinish`, which `HeadlessJsTaskContext.finishTask` also
   * dispatches to the UI thread; the write is therefore always queued ahead
   * of any finish callback.
   */
  private suspend fun runTask(reactContext: ReactContext) {
    val taskContext = HeadlessJsTaskContext.getInstance(reactContext)
    val startedTaskId = AtomicInteger(NO_TASK_ID)
    val finished = CompletableDeferred<Unit>()

    val listener =
      object : HeadlessJsTaskEventListener {
        override fun onHeadlessJsTaskStart(taskId: Int) = Unit

        override fun onHeadlessJsTaskFinish(taskId: Int) {
          // Another task may be running concurrently; only ours ends this tick.
          if (taskId == startedTaskId.get()) {
            finished.complete(Unit)
          }
        }
      }

    taskContext.addTaskEventListener(listener)
    try {
      val posted =
        UiThreadUtil.runOnUiThread {
          try {
            startedTaskId.set(taskContext.startTask(taskConfig()))
          } catch (error: Exception) {
            // Never let this escape onto the main thread: it would crash the app.
            finished.completeExceptionally(error)
          }
        }
      check(posted) { "Could not post the headless task start onto the UI thread" }
      finished.await()
    } finally {
      taskContext.removeTaskEventListener(listener)
    }
  }

  private fun taskConfig(): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      TASK_KEY,
      Arguments.createMap(),
      TASK_TIMEOUT_MS,
      // Allowed in foreground too: a tick that lands while the app is open is
      // harmless (the engine's leases make concurrent runs safe).
      true,
    )

  private companion object {
    const val TAG = "CempSyncWorker"
    const val TASK_KEY = "CempBackgroundSync"
    const val TASK_TIMEOUT_MS = 120_000L

    /** Slack over React Native's own task timeout before we call the runtime wedged. */
    const val TIMEOUT_GRACE_MS = 15_000L
    const val CONTEXT_START_TIMEOUT_MS = 60_000L
    const val NO_TASK_ID = -1
  }
}
