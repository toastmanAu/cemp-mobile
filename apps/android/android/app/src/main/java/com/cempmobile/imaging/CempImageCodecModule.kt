package com.cempmobile.imaging

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native image codec (spec §9.1 + design §1). Holds decoded bitmaps in a
 * handle registry keyed by int; JS drives decode -> resize -> encode -> release.
 * decode() BAKES EXIF orientation into pixels and re-encode drops ALL metadata
 * by construction (task 2 security guarantee). Bytes cross the bridge as hex.
 */
class CempImageCodecModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val bitmaps = ConcurrentHashMap<Int, Bitmap>()
  private val nextHandle = AtomicInteger(1)

  override fun getName(): String = "CempImageCodec"

  @ReactMethod
  fun decode(bytesHex: String, promise: Promise) {
    Thread {
      try {
        val bytes = hexToBytes(bytesHex)
        var raw: Bitmap? = decodeSampled(bytes)
        var oriented: Bitmap? = null
        try {
          oriented = applyExifOrientation(raw!!, bytes)
          // Ownership has moved to `oriented` (applyExifOrientation either
          // returned `raw` itself or recycled it for the rotated copy).
          raw = null
          promise.resolve(store(oriented))
          // Ownership has moved to the handle registry.
          oriented = null
        } finally {
          // Error path: never leak a decoded bitmap.
          raw?.recycle()
          oriented?.recycle()
        }
      } catch (e: Throwable) {
        promise.reject("image-decode-error", "could not decode image", asException(e))
      }
    }.start()
  }

  @ReactMethod
  fun resize(handle: Int, width: Int, height: Int, promise: Promise) {
    Thread {
      try {
        val src = bitmaps[handle] ?: throw IllegalStateException("resize: unknown handle $handle")
        val scaled = Bitmap.createScaledBitmap(src, width, height, true)
        // createScaledBitmap returns the SAME object (no copy) when width/height match the
        // source's dimensions. Storing that alias under a new handle would let two handles
        // share one bitmap; recycling either one leaves the other a use-after-recycle crash.
        // Defensive copy so each handle owns a distinct bitmap.
        val result = if (scaled === src) {
          scaled.copy(scaled.config ?: Bitmap.Config.ARGB_8888, false)
        } else {
          scaled
        }
        promise.resolve(store(result))
      } catch (e: Throwable) {
        promise.reject("image-resize-error", "could not resize image", asException(e))
      }
    }.start()
  }

  @ReactMethod
  fun encode(handle: Int, format: String, quality: Int, promise: Promise) {
    Thread {
      try {
        val bmp = bitmaps[handle] ?: throw IllegalStateException("encode: unknown handle $handle")
        val fmt = when (format) {
          "jpeg" -> Bitmap.CompressFormat.JPEG
          "webp" -> if (android.os.Build.VERSION.SDK_INT >= 30)
            Bitmap.CompressFormat.WEBP_LOSSY else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
          else -> throw IllegalArgumentException("encode: unsupported format $format")
        }
        val out = ByteArrayOutputStream()
        if (!bmp.compress(fmt, quality, out)) throw IllegalStateException("encode: compress failed")
        promise.resolve(bytesToHex(out.toByteArray()))
      } catch (e: Throwable) {
        promise.reject("image-encode-error", "could not encode image", asException(e))
      }
    }.start()
  }

  @ReactMethod
  fun release(handle: Int, promise: Promise) {
    // Deliberately synchronous (no Thread{}): Bitmap.recycle() is cheap, unlike
    // decode/resize/encode which do real pixel work off the UI thread.
    try {
      bitmaps.remove(handle)?.recycle()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("image-release-error", "could not release image", asException(e))
    }
  }

  private fun store(bitmap: Bitmap): WritableMap {
    val handle = nextHandle.getAndIncrement()
    bitmaps[handle] = bitmap
    return Arguments.createMap().apply {
      putInt("handle", handle)
      putInt("width", bitmap.width)
      putInt("height", bitmap.height)
    }
  }

  /**
   * Two-pass sampled decode (review: OOM on huge source images). An unbounded
   * `decodeByteArray` on a 50 MP photo allocates ~200 MB and OOMs the app, so
   * the first pass only reads the bounds and the second decodes with a
   * power-of-two `inSampleSize` that caps the decoded longest edge at
   * [MAX_DECODE_EDGE_PX] — ample headroom over the pipeline's first 960 px
   * compress target.
   */
  private fun decodeSampled(bytes: ByteArray): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw IllegalArgumentException("decode: not a decodable image")
    }
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, MAX_DECODE_EDGE_PX)
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
      ?: throw IllegalArgumentException("decode: not a decodable image")
  }

  private fun applyExifOrientation(bitmap: Bitmap, bytes: ByteArray): Bitmap {
    val exif = ExifInterface(ByteArrayInputStream(bytes))
    val orientation = exif.getAttributeInt(
      ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL,
    )
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
    if (rotated != bitmap) bitmap.recycle()
    return rotated
  }

  private fun asException(e: Throwable): Exception? = if (e is Exception) e else null

  companion object {
    /** Cap on the decoded longest edge (px) — see decodeSampled. */
    private const val MAX_DECODE_EDGE_PX = 2560

    /**
     * The smallest power-of-two `inSampleSize` that brings the longest edge
     * down to ≤ maxEdge — the most quality that still bounds the allocation.
     */
    fun sampleSizeFor(width: Int, height: Int, maxEdge: Int): Int {
      var sample = 1
      var longest = maxOf(width, height)
      while (longest > maxEdge) {
        sample *= 2
        longest /= 2
      }
      return sample
    }

    fun hexToBytes(hex: String): ByteArray {
      val out = ByteArray(hex.length / 2)
      for (i in out.indices) {
        // substring(...).toInt(16) throws NumberFormatException on non-hex input instead of
        // Character.digit's silent -1-on-garbage (matches CempKdfModule's hexToBytes idiom).
        out[i] = hex.substring(2 * i, 2 * i + 2).toInt(16).toByte()
      }
      return out
    }
    fun bytesToHex(bytes: ByteArray): String {
      val sb = StringBuilder(bytes.size * 2)
      for (b in bytes) sb.append("%02x".format(b.toInt() and 0xff))
      return sb.toString()
    }
  }
}
