package com.cempmobile.share

import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class CempShareModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempShare"

  @ReactMethod
  fun shareImage(pngHex: String, caption: String, promise: Promise) {
    try {
      val bytes = ByteArray(pngHex.length / 2) { i ->
        ((Character.digit(pngHex[i * 2], 16) shl 4) +
          Character.digit(pngHex[i * 2 + 1], 16)).toByte()
      }
      val dir = File(reactApplicationContext.cacheDir, "share").apply { mkdirs() }
      // Overwritten each time: the card is regenerated on demand, and a stale
      // file must never be shared after the profile changes.
      val file = File(dir, "cellsend-contact.png")
      file.writeBytes(bytes)

      val uri = FileProvider.getUriForFile(
        reactApplicationContext,
        "${reactApplicationContext.packageName}.fileprovider",
        file,
      )
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TEXT, caption)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, null).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactApplicationContext.startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("share-error", "could not present the share sheet", e)
    }
  }
}
