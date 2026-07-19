package com.cempmobile.background

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Starts the headless JS task on each WorkManager tick. */
class CempSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    return try {
      applicationContext.startService(Intent(applicationContext, CempSyncTaskService::class.java))
      Result.success()
    } catch (error: IllegalStateException) {
      // Android forbids starting the service from the background in some
      // states; WorkManager will retry on the next window.
      Result.retry()
    }
  }
}
