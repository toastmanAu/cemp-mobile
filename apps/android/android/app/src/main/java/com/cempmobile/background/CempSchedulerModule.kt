package com.cempmobile.background

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
      val policy =
        if (replaceExisting) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP
      WorkManager.getInstance(reactApplicationContext)
        .enqueueUniquePeriodicWork(PERIODIC_WORK, policy, request)
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
  }
}
