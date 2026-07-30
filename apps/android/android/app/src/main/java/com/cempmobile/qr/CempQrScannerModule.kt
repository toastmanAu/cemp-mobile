package com.cempmobile.qr

import android.graphics.BitmapFactory
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

/**
 * Still-image QR decode (design's photo-path scan). A full-resolution
 * camera-roll photo (e.g. 4032x3024) means a multi-ten-MB IntArray plus a
 * same-size Bitmap before recycle, and ZXing detection over all of it — real
 * work, never the JS/UI thread. Runs on a plain Thread, matching
 * CempKdfModule (argon2id/scrypt) and CempImagePickerModule (file read): the
 * native-modules invocation thread is shared across all in-flight bridge
 * calls, so anything non-trivial has to get off it.
 */
class CempQrScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

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
}
