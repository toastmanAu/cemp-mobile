package com.cempmobile.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Notification adapter for the @cemp/ui `Notifier`. Channel ids are chosen by
 * TypeScript (NOTIFICATION_CHANNELS) and are user-visible in system settings,
 * so they must stay stable.
 *
 * Security: message contents and sender identity must never appear on a
 * locked device. The caller-supplied title/body are themselves generic by
 * construction (see cemp-sync's workers.ts) rather than relying on this
 * being reachable only via a device setting the app cannot verify, but
 * VISIBILITY_PRIVATE plus a generic `setPublicVersion` stay on as
 * defence in depth for a secure lock screen. `setLocalOnly(true)` stops the
 * notification from mirroring to a paired Wear OS watch, which is often
 * ambient-on and less secured than the phone.
 */
class CempNotifierModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempNotifier"

  private fun ensureChannel(id: String, importance: Int) {
    val manager =
      reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(id) == null) {
      manager.createNotificationChannel(NotificationChannel(id, id, importance))
    }
  }

  @ReactMethod
  fun post(id: String, channel: String, title: String, body: String, promise: Promise) {
    try {
      val importance =
        if (channel == "messages") NotificationManager.IMPORTANCE_HIGH
        else NotificationManager.IMPORTANCE_LOW
      ensureChannel(channel, importance)
      // Shown on a secure lock screen instead of the real title/body below.
      val publicVersion =
        NotificationCompat.Builder(reactApplicationContext, channel)
          .setSmallIcon(android.R.drawable.ic_dialog_email)
          .setContentTitle(PUBLIC_TITLE)
          .setContentText(PUBLIC_BODY)
          .setAutoCancel(true)
          .build()
      val notification =
        NotificationCompat.Builder(reactApplicationContext, channel)
          .setSmallIcon(android.R.drawable.ic_dialog_email)
          .setContentTitle(title)
          .setContentText(body)
          .setAutoCancel(true)
          .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
          .setPublicVersion(publicVersion)
          // A paired Wear OS watch is often ambient-on and less secured than
          // the phone; mirroring there would bypass the visibility/redaction
          // handling above. Keep this notification phone-only.
          .setLocalOnly(true)
          .build()
      // Stable id: a re-post replaces rather than stacks.
      NotificationManagerCompat.from(reactApplicationContext).notify(id.hashCode(), notification)
      promise.resolve(null)
    } catch (error: SecurityException) {
      // POST_NOTIFICATIONS not granted — sync must continue regardless.
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("notifier_error", error.message, error)
    }
  }

  @ReactMethod
  fun cancel(id: String, promise: Promise) {
    try {
      NotificationManagerCompat.from(reactApplicationContext).cancel(id.hashCode())
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("notifier_error", error.message, error)
    }
  }

  private companion object {
    const val PUBLIC_TITLE = "CellSend"
    const val PUBLIC_BODY = "New activity"
  }
}
