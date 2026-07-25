package com.cempmobile.imaging

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream

/**
 * System Photo Picker (design §1). No storage permission on API 33+; AndroidX
 * PickVisualMedia shims older versions. Returns raw image bytes as hex, or null
 * when the user cancels. Holds one pending promise across the activity result.
 */
class CempImagePickerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private var pending: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "CempImagePicker"

  @ReactMethod
  fun pick(promise: Promise) {
    // getCurrentActivity() is deprecated in RN 0.83 in favor of the ReactApplicationContext
    // property directly.
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("image-pick-error", "no foreground activity to launch the picker")
      return
    }
    // Reject any prior in-flight pick before starting a new one.
    pending?.reject("image-pick-cancelled", "superseded by a new pick")
    pending = promise
    try {
      val request = PickVisualMediaRequest.Builder()
        .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
        .build()
      val intent = ActivityResultContracts.PickVisualMedia().createIntent(activity, request)
      activity.startActivityForResult(intent, REQUEST_CODE)
    } catch (e: Throwable) {
      pending = null
      promise.reject("image-pick-error", "could not launch the photo picker", if (e is Exception) e else null)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val promise = pending ?: return
    pending = null
    if (resultCode != Activity.RESULT_OK) {
      promise.resolve(null) // cancel -> null (spec §4 item 2)
      return
    }
    val uri: Uri? = data?.data
    if (uri == null) {
      promise.resolve(null)
      return
    }
    Thread {
      try {
        val bytes = readAllBytes(activity, uri)
        promise.resolve(CempImageCodecModule.bytesToHex(bytes))
      } catch (e: Throwable) {
        promise.reject("image-pick-read-error", "could not read the selected image", if (e is Exception) e else null)
      }
    }.start()
  }

  override fun onNewIntent(intent: Intent) { /* not used */ }

  private fun readAllBytes(activity: Activity, uri: Uri): ByteArray {
    activity.contentResolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "could not open the selected image stream" }
      val out = ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        out.write(buf, 0, n)
      }
      return out.toByteArray()
    }
  }

  companion object {
    private const val REQUEST_CODE = 0xC0DE
  }
}
