package com.cempmobile.background

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JS task registered as "CempBackgroundSync" (apps/android/index.js).
 * Phase 9 design D3: all protocol logic stays in TypeScript, so this service
 * only hands control to the JS runtime.
 */
class CempSyncTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      "CempBackgroundSync",
      Arguments.createMap(),
      TASK_TIMEOUT_MS,
      // Allowed in foreground too: a tick that lands while the app is open is
      // harmless (the engine's leases make concurrent runs safe).
      true,
    )

  private companion object {
    const val TASK_TIMEOUT_MS = 120_000L
  }
}
