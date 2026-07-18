package com.cempmobile.kdf

import android.os.SystemClock
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.generators.SCrypt
import org.bouncycastle.crypto.params.Argon2Parameters

/**
 * Native password-KDF for the CEMP vault (packages/cemp-secure-vault kdf.ts
 * `KdfEngine`). Pure-JS memory-hard KDFs are unusably slow under Hermes —
 * argon2id m=19 MiB/t=2 exceeded four minutes on a Galaxy A53 — so the vault
 * derives through this Bouncy Castle module at full RFC 9106 strength.
 *
 * Output MUST be byte-identical to @noble/hashes argon2id/scrypt for the
 * same inputs (the vault file is engine-agnostic; params are recorded).
 * Both methods run on a pooled thread — never the JS or UI thread.
 */
class CempKdfModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempKdf"

  @ReactMethod
  fun argon2id(
    passwordHex: String,
    saltHex: String,
    mKiB: Int,
    t: Int,
    p: Int,
    outBytes: Int,
    promise: Promise,
  ) {
    Thread {
      val startedAt = SystemClock.elapsedRealtime()
      try {
        val params =
          Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(t)
            .withMemoryAsKB(mKiB)
            .withParallelism(p)
            .withSalt(hexToBytes(saltHex))
            .build()
        val generator = Argon2BytesGenerator()
        generator.init(params)
        val out = ByteArray(outBytes)
        generator.generateBytes(hexToBytes(passwordHex), out)
        // Timing only — never any input or output bytes (AGENTS.md rule 2).
        android.util.Log.i(
          "CempKdf",
          "argon2id m=${mKiB}KiB t=$t p=$p completed in ${SystemClock.elapsedRealtime() - startedAt}ms",
        )
        promise.resolve(bytesToHex(out))
      } catch (e: Throwable) {
        // Throwable: Errors (e.g. OutOfMemoryError) must also reject, or the
        // JS promise never settles.
        android.util.Log.e("CempKdf", "argon2id failed after ${SystemClock.elapsedRealtime() - startedAt}ms: ${e.javaClass.simpleName}")
        promise.reject("kdf-error", "argon2id derivation failed", if (e is Exception) e else null)
      }
    }.start()
  }

  @ReactMethod
  fun scrypt(
    passwordHex: String,
    saltHex: String,
    logN: Int,
    r: Int,
    p: Int,
    outBytes: Int,
    promise: Promise,
  ) {
    Thread {
      try {
        val n = 1 shl logN
        val out = SCrypt.generate(hexToBytes(passwordHex), hexToBytes(saltHex), n, r, p, outBytes)
        promise.resolve(bytesToHex(out))
      } catch (e: Exception) {
        promise.reject("kdf-error", "scrypt derivation failed", e)
      }
    }.start()
  }

  companion object {
    fun hexToBytes(hex: String): ByteArray {
      val out = ByteArray(hex.length / 2)
      var i = 0
      while (i < out.size) {
        out[i] = hex.substring(2 * i, 2 * i + 2).toInt(16).toByte()
        i++
      }
      return out
    }

    fun bytesToHex(bytes: ByteArray): String {
      val sb = StringBuilder(bytes.size * 2)
      for (b in bytes) {
        sb.append(String.format("%02x", b))
      }
      return sb.toString()
    }
  }
}
