package com.cempmobile

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "CempMobile"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * react-native-screens cannot restore its fragments: passing the saved state through crashes
   * ("Screen fragments should never be restored") whenever Android recreates the activity —
   * a Bold text / font change, or restoring a process the system reclaimed. JS re-renders the
   * navigation tree from scratch instead.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Android 12+ applies the Bold text setting (fontWeightAdjustment) inside TextView at draw
   * time, but React Native measures text without it, so bolded text overflows its box and the
   * last word is clipped. Zero it for this activity; the JS Text wrappers re-apply the real
   * setting (read from the application context by CempTextWeight) as a style RN measures.
   */
  override fun attachBaseContext(newBase: Context) {
    super.attachBaseContext(newBase)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      applyOverrideConfiguration(Configuration().apply { fontWeightAdjustment = 0 })
    }
  }
}
