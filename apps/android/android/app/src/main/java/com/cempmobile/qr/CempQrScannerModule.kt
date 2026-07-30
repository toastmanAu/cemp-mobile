package com.cempmobile.qr

import android.graphics.BitmapFactory
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer

class CempQrScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempQrScanner"

  @ReactMethod
  fun scanImage(bytesHex: String, promise: Promise) {
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
        return
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
      // No code found is a normal outcome, not an error: resolve null so the
      // UI can say "no contact code in that image" rather than showing a fault.
      val text = try {
        reader.decode(BinaryBitmap(HybridBinarizer(source))).text
      } catch (e: NotFoundException) {
        null
      }
      promise.resolve(text)
    } catch (e: Throwable) {
      promise.reject("qr-decode-error", "could not decode that image", if (e is Exception) e else null)
    }
  }
}
