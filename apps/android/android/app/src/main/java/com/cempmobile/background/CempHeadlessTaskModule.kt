package com.cempmobile.background

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Lets the headless JS task tell native it is done, replacing React Native's
 * own `HeadlessJsTaskSupport` module — which is not registered under the New
 * Architecture (see [CempHeadlessTaskRegistry] for the evidence).
 *
 * Thin adapter, per Phase 9 design D3: no protocol logic here. The JS side
 * decides *when* a tick is over (success or degraded alike); this only relays
 * that decision.
 */
class CempHeadlessTaskModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempHeadlessTask"

  /**
   * Finish the headless task behind [tickId].
   *
   * Deliberately fire-and-forget (no Promise): the JS caller has nothing left
   * to do with the answer, and making it await a round trip would keep the
   * runtime alive for exactly the reason we are trying to remove. Unknown and
   * already-finished ids are no-ops.
   */
  @ReactMethod
  fun notifyTaskFinished(tickId: Double) {
    val id = tickId.toInt()
    // The tick id is a process-local counter; it carries no user data.
    val finished = CempHeadlessTaskRegistry.finish(id)
    if (finished) {
      Log.i(TAG, "notifyTaskFinished: finished headless task for tick id=$id")
    } else {
      Log.i(TAG, "notifyTaskFinished: no active task for tick id=$id; ignoring")
    }
  }

  private companion object {
    const val TAG = "CempSync"
  }
}
