package com.cempmobile.background

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.TimeUnit

/**
 * WorkManager adapter for the @cemp/sync `Scheduler` (Phase 9 design D4).
 * The TypeScript side has already coalesced every worker's periodic request
 * into a single tick, so this module schedules exactly one periodic work.
 */
class CempSchedulerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempScheduler"

  private fun constraints(requiresNetwork: Boolean): Constraints =
    Constraints.Builder()
      .setRequiredNetworkType(if (requiresNetwork) NetworkType.CONNECTED else NetworkType.NOT_REQUIRED)
      .build()

  /**
   * Enqueue the single coalesced tick.
   *
   * [replaceExisting] is decided entirely on the TypeScript side, which owns
   * the coalescing state and therefore knows whether the tick's parameters
   * actually changed. KEEP lets an already-running tick retain its period
   * across the re-registration that happens on every vault unlock; UPDATE is
   * used only when the interval or network constraint genuinely differs, so
   * the change takes effect instead of being silently ignored.
   *
   * One case [replaceExisting] cannot cover: an app upgrade that changes the
   * tick's shape. The TypeScript SpecRegistry coalesces in memory and always
   * sends `replaceExisting=false` for the FIRST tick of a process, so a fresh
   * process after an upgrade would KEEP the WorkSpec the OLD binary enqueued and
   * run the STALE interval forever. Guard that with a persisted [SCHEDULE_VERSION]:
   * a mismatch — only reachable straight after an upgrade that bumped it — forces
   * UPDATE exactly once so the new interval/constraints take, then normal KEEP
   * semantics resume.
   */
  @ReactMethod
  fun schedulePeriodic(
    intervalMs: Double,
    requiresNetwork: Boolean,
    replaceExisting: Boolean,
    promise: Promise
  ) {
    try {
      val request =
        PeriodicWorkRequestBuilder<CempSyncWorker>(intervalMs.toLong(), TimeUnit.MILLISECONDS)
          .setConstraints(constraints(requiresNetwork))
          .build()
      val prefs =
        reactApplicationContext.getSharedPreferences(SCHEDULER_PREFS, Context.MODE_PRIVATE)
      val upgraded = prefs.getInt(KEY_SCHEDULE_VERSION, 0) != SCHEDULE_VERSION
      val policy =
        if (replaceExisting || upgraded) ExistingPeriodicWorkPolicy.UPDATE
        else ExistingPeriodicWorkPolicy.KEEP
      WorkManager.getInstance(reactApplicationContext)
        .enqueueUniquePeriodicWork(PERIODIC_WORK, policy, request)
      // Only after a successful enqueue: a failure must leave the stale version
      // stored so the next attempt still forces the upgrade UPDATE.
      if (upgraded) {
        prefs.edit().putInt(KEY_SCHEDULE_VERSION, SCHEDULE_VERSION).apply()
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  @ReactMethod
  fun scheduleOneShot(id: String, delayMs: Double, promise: Promise) {
    try {
      val request =
        OneTimeWorkRequestBuilder<CempSyncWorker>()
          .setInitialDelay(delayMs.toLong(), TimeUnit.MILLISECONDS)
          .setConstraints(constraints(true))
          .build()
      WorkManager.getInstance(reactApplicationContext)
        .enqueueUniqueWork(id, ExistingWorkPolicy.REPLACE, request)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  /**
   * Cancel the coalesced periodic tick. Used by the factory wipe so no
   * background work keeps waking for a wiped identity — `cancel(id)` cannot
   * reach it, because the periodic request is enqueued under the fixed unique
   * name [PERIODIC_WORK] rather than any worker id.
   */
  @ReactMethod
  fun cancelPeriodic(promise: Promise) {
    try {
      WorkManager.getInstance(reactApplicationContext).cancelUniqueWork(PERIODIC_WORK)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  @ReactMethod
  fun cancel(id: String, promise: Promise) {
    try {
      WorkManager.getInstance(reactApplicationContext).cancelUniqueWork(id)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  private companion object {
    const val PERIODIC_WORK = "cemp-sync-tick"

    /**
     * Bump whenever a release changes the coalesced tick's interval or network
     * constraint. The change is what tells an upgraded app to force a one-time
     * UPDATE over the WorkSpec the previous binary enqueued under KEEP.
     */
    const val SCHEDULE_VERSION = 1
    const val SCHEDULER_PREFS = "cemp_scheduler"
    const val KEY_SCHEDULE_VERSION = "schedule_version"
  }
}
