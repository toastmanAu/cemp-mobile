package com.cempmobile.qr

import android.app.Activity
import android.content.Intent
import android.graphics.BitmapFactory
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.ReaderException
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.atomic.AtomicReference

/**
 * QR decode: still-image (design's photo-path scan) and live camera
 * (design's camera-path scan, via QrScannerActivity). A full-resolution
 * camera-roll photo (e.g. 4032x3024) means a multi-ten-MB IntArray plus a
 * same-size Bitmap before recycle, and ZXing detection over all of it — real
 * work, never the JS/UI thread. scanImage runs on a plain Thread, matching
 * CempKdfModule (argon2id/scrypt) and CempImagePickerModule (file read): the
 * native-modules invocation thread is shared across all in-flight bridge
 * calls, so anything non-trivial has to get off it.
 *
 * scanWithCamera follows CempImagePickerModule's activity-result pattern: the
 * module implements ActivityEventListener directly and holds one pending
 * promise, because the activity result can arrive after the process was
 * paused — a synchronous return can't be assumed.
 */
class CempQrScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  private val pending = AtomicReference<Promise?>(null)

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName(): String = "CempQrScanner"

  @ReactMethod
  fun scanImage(bytesHex: String, promise: Promise) {
    Thread {
      try {
        // TRUSTED-INPUT ONLY (matches apps/android/src/platform/hex.ts): no
        // validation here; the only caller is this app's own bytesToHex.
        val bytes = ByteArray(bytesHex.length / 2) { i ->
          ((Character.digit(bytesHex[i * 2], 16) shl 4) +
            Character.digit(bytesHex[i * 2 + 1], 16)).toByte()
        }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (bitmap == null) {
          promise.reject("qr-decode-error", "could not read that image")
          return@Thread
        }
        // Capture the dimensions BEFORE recycling — reading bitmap.width after
        // recycle() is undefined.
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        bitmap.recycle()

        val source = RGBLuminanceSource(width, height, pixels)
        val reader = MultiFormatReader().apply {
          setHints(mapOf(DecodeHintType.TRY_HARDER to true))
        }
        // This module answers one question — "is there a readable QR in this
        // image?" — so absence (NotFoundException: no pattern located) and
        // illegibility (ChecksumException/FormatException: a QR-shaped
        // pattern was found but failed validation, e.g. damaged, glare-hit or
        // partially obscured) both resolve null rather than reject. From the
        // caller's side both mean "try a clearer image". Catch the common
        // ReaderException superclass rather than NotFoundException alone —
        // do not narrow this back down. A QR that decodes fine but whose
        // *contents* fail validation is a separate, later concern belonging
        // to the bundle layer, not this module.
        val text = try {
          reader.decode(BinaryBitmap(HybridBinarizer(source))).text
        } catch (e: ReaderException) {
          null
        }
        promise.resolve(text)
      } catch (e: Throwable) {
        promise.reject("qr-decode-error", "could not decode that image", if (e is Exception) e else null)
      }
    }.start()
  }

  @ReactMethod
  fun scanWithCamera(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("qr-scan-error", "no foreground activity to launch the scanner")
      return
    }
    // Install the new promise and reject any prior in-flight scan, atomically
    // — matching CempImagePickerModule.pick, so a second call while one is
    // already open settles (not orphans) the first promise.
    val prior = pending.getAndSet(promise)
    prior?.reject("qr-scan-cancelled", "superseded by a new scan")
    try {
      activity.startActivityForResult(Intent(activity, QrScannerActivity::class.java), REQUEST_CODE)
    } catch (e: Throwable) {
      pending.compareAndSet(promise, null)
      promise.reject("qr-scan-error", "could not launch the camera scanner", if (e is Exception) e else null)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val promise = pending.getAndSet(null) ?: return
    // Cancel — including a denied camera permission — resolves null, not an
    // error: the screen keeps its photo and paste options.
    if (resultCode != Activity.RESULT_OK) {
      promise.resolve(null)
      return
    }
    promise.resolve(data?.getStringExtra(QrScannerActivity.EXTRA_TEXT))
  }

  override fun onNewIntent(intent: Intent) { /* not used */ }

  /**
   * Bridge teardown (RN 0.83 hook; onCatalystInstanceDestroy is deprecated):
   * reject any pending scan so the JS promise settles instead of hanging
   * forever, and drop the activity listener.
   */
  override fun invalidate() {
    reactApplicationContext.removeActivityEventListener(this)
    pending.getAndSet(null)?.reject(
      "qr-scan-cancelled",
      "the camera scanner was closed before a result arrived",
    )
  }

  companion object {
    private const val REQUEST_CODE = 4802
  }
}
