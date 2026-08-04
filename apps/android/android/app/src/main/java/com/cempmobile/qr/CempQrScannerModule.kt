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
import java.util.concurrent.atomic.AtomicInteger
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
 *
 * Unlike the picker, each scan gets its own request code (see PendingScan
 * below): scanWithCamera installs `pending` from the bridge thread while
 * onActivityResult reads/clears it from the main thread, with no ordering
 * guarantee between "a new scan starts" and "an old scan's activity
 * finishes". Keying the swap on requestCode, not merely on "is something
 * pending", stops a late result from activity A being delivered to the
 * promise for scan B. CempImagePickerModule carries the un-keyed version of
 * this race (a single shared REQUEST_CODE) — out of scope here, flagged for
 * separate follow-up.
 */
class CempQrScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), ActivityEventListener {

  /** A single in-flight scan: the promise plus the request code it was launched with. */
  private data class PendingScan(val requestCode: Int, val promise: Promise)

  private val pending = AtomicReference<PendingScan?>(null)
  private val nextRequestCode = AtomicInteger(0)

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
    // Every scan gets its own request code so a stray onActivityResult from a
    // still-finishing prior activity can never be mistaken for this scan's
    // result (see the class doc). Wrapped into a small range above the base —
    // only one scan is ever pending at a time, so this never needs to be
    // large, just distinct from the immediately preceding scan(s).
    val requestCode = REQUEST_CODE_BASE + (nextRequestCode.getAndIncrement() and REQUEST_CODE_MASK)
    val scan = PendingScan(requestCode, promise)
    // Install the new scan and reject any prior in-flight one, atomically —
    // matching CempImagePickerModule.pick, so a second call while one is
    // already open settles (not orphans) the first promise.
    val prior = pending.getAndSet(scan)
    prior?.promise?.reject("qr-scan-cancelled", "superseded by a new scan")
    try {
      activity.startActivityForResult(Intent(activity, QrScannerActivity::class.java), requestCode)
    } catch (e: Throwable) {
      pending.compareAndSet(scan, null)
      promise.reject("qr-scan-error", "could not launch the camera scanner", if (e is Exception) e else null)
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    // Read-then-swap rather than getAndSet(null): a result whose requestCode
    // doesn't match the CURRENTLY pending scan belongs to an already-superseded
    // one and must be dropped, not consumed into whatever promise happens to
    // be sitting in `pending` right now.
    val current = pending.get() ?: return
    if (current.requestCode != requestCode) return
    if (!pending.compareAndSet(current, null)) return
    // Plain cancel (back press, no usable camera) resolves null, not an
    // error: the screen keeps its photo and paste options. A denied camera
    // permission is deliberately NOT folded into that same null — it rejects
    // with a distinct code so the screen can show an honest message naming
    // the permission instead of doing nothing (spec's error-handling table).
    if (resultCode == QrScannerActivity.RESULT_PERMISSION_DENIED) {
      current.promise.reject("qr-permission-denied", "camera permission was denied")
      return
    }
    if (resultCode != Activity.RESULT_OK) {
      current.promise.resolve(null)
      return
    }
    current.promise.resolve(data?.getStringExtra(QrScannerActivity.EXTRA_TEXT))
  }

  override fun onNewIntent(intent: Intent) { /* not used */ }

  /**
   * Bridge teardown (RN 0.83 hook; onCatalystInstanceDestroy is deprecated):
   * reject any pending scan so the JS promise settles instead of hanging
   * forever, and drop the activity listener.
   */
  override fun invalidate() {
    reactApplicationContext.removeActivityEventListener(this)
    pending.getAndSet(null)?.promise?.reject(
      "qr-scan-cancelled",
      "the camera scanner was closed before a result arrived",
    )
  }

  companion object {
    // Arbitrary but distinct from CempImagePickerModule's REQUEST_CODE
    // (0xC0DE / 49374) and MainActivity's own request codes, so a result
    // meant for this module is never mistaken for another module's.
    private const val REQUEST_CODE_BASE = 0x4800
    private const val REQUEST_CODE_MASK = 0xFF
  }
}
