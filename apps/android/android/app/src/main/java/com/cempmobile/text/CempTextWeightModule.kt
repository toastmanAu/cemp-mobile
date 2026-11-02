package com.cempmobile.text

import android.content.res.Configuration
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Reports the system Bold text setting (Configuration.fontWeightAdjustment, Android 12+).
 *
 * Read from the APPLICATION context: MainActivity zeroes the adjustment in its own
 * configuration so TextView stops applying it behind React Native's back, which means the
 * activity no longer sees the real value. A promise rather than a constant, because the
 * setting can change while the JS runtime lives on (the app re-reads it on resume).
 */
class CempTextWeightModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempTextWeight"

  @ReactMethod
  fun getFontWeightAdjustment(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      promise.resolve(0)
      return
    }
    val adjustment = reactApplicationContext.applicationContext.resources.configuration
      .fontWeightAdjustment
    promise.resolve(
      if (adjustment == Configuration.FONT_WEIGHT_ADJUSTMENT_UNDEFINED) 0 else adjustment
    )
  }
}
