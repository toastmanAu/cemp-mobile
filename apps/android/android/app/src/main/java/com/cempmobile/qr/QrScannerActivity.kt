package com.cempmobile.qr

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.cempmobile.R
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Live camera QR scan (design's camera-path scan). Binds a CameraX analyser
 * that feeds luminance frames straight to ZXing — no MLKit, matching
 * CempQrScannerModule.scanImage's still-image path. Cancel (back press or a
 * denied CAMERA permission) finishes with RESULT_CANCELED so the caller
 * resolves null rather than treating it as an error.
 */
class QrScannerActivity : AppCompatActivity() {
  companion object {
    const val EXTRA_TEXT = "qr_text"
    private const val PERMISSION_REQUEST = 4801
  }

  private val analysisExecutor = Executors.newSingleThreadExecutor()
  private val done = AtomicBoolean(false)
  private val reader = MultiFormatReader().apply {
    setHints(mapOf(DecodeHintType.TRY_HARDER to true))
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_qr_scanner)
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      startCamera()
    } else {
      ActivityCompat.requestPermissions(
        this, arrayOf(Manifest.permission.CAMERA), PERMISSION_REQUEST,
      )
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != PERMISSION_REQUEST) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      // A denied permission is a cancel, not a crash: the JS side resolves null
      // and the screen keeps its photo and paste options.
      finishWith(null)
    }
  }

  private fun startCamera() {
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener({
      val provider = future.get()
      val preview = Preview.Builder().build().also {
        it.surfaceProvider = findViewById<PreviewView>(R.id.preview).surfaceProvider
      }
      val analysis = ImageAnalysis.Builder()
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
      analysis.setAnalyzer(analysisExecutor) { proxy -> analyse(proxy) }
      provider.unbindAll()
      provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    }, ContextCompat.getMainExecutor(this))
  }

  private fun analyse(proxy: ImageProxy) {
    try {
      if (done.get()) return
      val plane = proxy.planes[0]
      val buffer = plane.buffer
      val data = ByteArray(buffer.remaining())
      buffer.get(data)
      val source = PlanarYUVLuminanceSource(
        data, plane.rowStride, proxy.height, 0, 0, plane.rowStride.coerceAtMost(proxy.width),
        proxy.height, false,
      )
      val text = try {
        reader.decode(BinaryBitmap(HybridBinarizer(source))).text
      } catch (e: NotFoundException) {
        null
      }
      if (text != null && done.compareAndSet(false, true)) {
        runOnUiThread { finishWith(text) }
      }
    } catch (e: Throwable) {
      // A bad frame is not a failure — keep scanning.
    } finally {
      reader.reset()
      proxy.close()
    }
  }

  private fun finishWith(text: String?) {
    if (text == null) {
      setResult(Activity.RESULT_CANCELED)
    } else {
      setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_TEXT, text))
    }
    finish()
  }

  override fun onDestroy() {
    analysisExecutor.shutdown()
    super.onDestroy()
  }
}
