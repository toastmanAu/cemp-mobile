# Contact Sharing — Slice 2 (receive side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can add a contact by scanning a CellSend card with the camera, decoding one from a saved photo, or pasting the code text.

**Architecture:** All classification logic — parse, self-card detection, duplicate detection, prefix normalisation — lives in one RN-free module in `packages/cemp-core` and is fully unit-tested on Linux. A new `CempQrScanner` native module does only what JS cannot: decode a still image and run a camera scanner, each as a promise-returning method that presents platform UI, exactly like the `CempShare` module slice 1 shipped. One screen drives all three input methods.

**Tech Stack:** TypeScript, React Native 0.83.10, vitest, Kotlin (CameraX + ZXing), Objective-C (AVFoundation + Vision), `xcodeproj` for Xcode target wiring.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-contact-sharing-design.md`. Read its "Slice 2 implementation notes" section — it records facts you must not re-derive.
- **Do NOT modify `packages/cemp-core/src/contact-bundle.ts`.** It is a spec'd §5.4 wire format, fuzz-tested by `hardening-fuzz.test.ts`. Decoding a scan goes through its existing `decodeContactBundle`; no new codec is written.
- **THE PREFIX ASYMMETRY — the most bug-prone detail in this slice.** `ContactBundleV1.profileTypeId` is `0x`-prefixed 64 hex (66 chars). The contacts table's `profileIdHex` is stored **without** the prefix (64 chars) — see `MessagingService#myContactBundle`, which builds the bundle as `` `0x${profileIdHex}` ``. Every comparison against `ContactRepository.getByProfileId()` or against `myProfileId()` must normalise first. A mismatch here does not throw: it silently makes every duplicate look new and every self-card look like a stranger.
- **A scanned bundle is hostile input** (AGENTS.md rule 4). `decodeContactBundle` already rejects unknown protocol/version, wrong network (rule 11), malformed hex/bech32 and non-canonical fingerprints. Never bypass it.
- Never log bundle contents, fingerprints, display names, or decoded payloads (AGENTS.md rule 2). Rendering on screen is the point; logging is forbidden.
- Android decoding uses **ZXing (`com.google.zxing:core`)**, not MLKit — no Google Play Services in a privacy-focused messenger. iOS uses **Vision** for stills and **AVCaptureMetadataOutput** for live camera; both first-party.
- **`NSCameraUsageDescription` is mandatory** in `apps/android/ios/CempMobile/Info.plist`. Its absence is a hard crash on first camera use, not a denied permission. The existing image picker needs no photo-library description because `PHPickerViewController` does not require one — the camera is different.
- Android: minSdk 24, compileSdk 36, Kotlin 2.1.20. `CAMERA` is a runtime permission at this minSdk.
- The scanner presents platform UI and resolves a promise. **No React Native view component is written.**
- Gates before every commit: `npm run typecheck`, `npx eslint .`, `npx prettier --check .`, `npx vitest run`. Baseline at plan time: **671 passed, 1 skipped, 80 files**.
- `npx prettier --check .` reports untracked local scratch (`.remember/`, generated vectors). Only tracked files matter; CI uses a fresh checkout.

---

### Task 1: Scanned-card classification (the testable core)

**Files:**

- Create: `packages/cemp-core/src/contact-import.ts`
- Create: `packages/cemp-core/src/contact-import.test.ts`
- Modify: `packages/cemp-core/src/index.ts` (export)

**Interfaces:**

- Consumes: `decodeContactBundle`, `type ContactBundleV1` from `./contact-bundle.js`.
- Produces:
  - `function normalizeProfileId(value: string): string` — strips a leading `0x`, lowercases. The single place the prefix asymmetry is resolved.
  - `type ScanOutcome` (discriminated union on `kind`):
    - `{ kind: "addable"; bundle: ContactBundleV1 }`
    - `{ kind: "self"; bundle: ContactBundleV1 }`
    - `{ kind: "duplicate"; bundle: ContactBundleV1; existingContactId: number }`
    - `{ kind: "unreadable"; reason: string }`
  - `function classifyScannedCard(input: { text: string; myProfileIdHex: string | null; findExisting: (profileIdHex: string) => { id: number } | undefined }): ScanOutcome`

  Tasks 5 consumes all of these.

- [ ] **Step 1: Write the failing tests**

Create `packages/cemp-core/src/contact-import.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeContactBundle, type ContactBundleV1 } from "./contact-bundle.js";
import { classifyScannedCard, normalizeProfileId } from "./contact-import.js";

const THEIR_ID = "ab".repeat(32);
const MY_ID = "cd".repeat(32);

const BUNDLE: ContactBundleV1 = {
  profileTypeId: `0x${THEIR_ID}`,
  lockScriptHash: `0x${"ef".repeat(32)}`,
  address: `ckt1${"q".repeat(120)}`,
  fingerprint: "ABCD-1234-5678-90AB-CDEF-0123-4567-89AB",
  network: "ckb_testnet",
};

const none = () => undefined;

describe("normalizeProfileId", () => {
  it("strips a 0x prefix and lowercases", () => {
    expect(normalizeProfileId(`0x${"AB".repeat(32)}`)).toBe("ab".repeat(32));
  });

  it("leaves an unprefixed id alone", () => {
    expect(normalizeProfileId(THEIR_ID)).toBe(THEIR_ID);
  });
});

describe("classifyScannedCard", () => {
  it("returns addable for a stranger's valid card", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle(BUNDLE),
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("addable");
    if (out.kind === "addable") expect(out.bundle.fingerprint).toBe(BUNDLE.fingerprint);
  });

  // The prefix asymmetry: the bundle carries 0x, the database does not.
  it("detects a self-card across the 0x prefix boundary", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle({ ...BUNDLE, profileTypeId: `0x${MY_ID}` }),
      myProfileIdHex: MY_ID, // unprefixed, as the database stores it
      findExisting: none,
    });
    expect(out.kind).toBe("self");
  });

  it("detects a duplicate across the 0x prefix boundary", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle(BUNDLE),
      myProfileIdHex: MY_ID,
      // The repository is queried with the UNPREFIXED id.
      findExisting: (id) => (id === THEIR_ID ? { id: 42 } : undefined),
    });
    expect(out.kind).toBe("duplicate");
    if (out.kind === "duplicate") expect(out.existingContactId).toBe(42);
  });

  it("prefers self over duplicate when both would match", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle({ ...BUNDLE, profileTypeId: `0x${MY_ID}` }),
      myProfileIdHex: MY_ID,
      findExisting: () => ({ id: 7 }),
    });
    expect(out.kind).toBe("self");
  });

  it("treats an unpublished own profile as not-self", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle(BUNDLE),
      myProfileIdHex: null,
      findExisting: none,
    });
    expect(out.kind).toBe("addable");
  });

  it("reports unreadable for junk, with a reason", () => {
    for (const text of ["", "not json", "{}", '{"protocol":"nope","version":1}']) {
      const out = classifyScannedCard({ text, myProfileIdHex: MY_ID, findExisting: none });
      expect(out.kind).toBe("unreadable");
      if (out.kind === "unreadable") expect(out.reason.length).toBeGreaterThan(0);
    }
  });

  it("reports unreadable for a wrong-network bundle (rule 11)", () => {
    const out = classifyScannedCard({
      text: encodeContactBundle({ ...BUNDLE, network: "ckb_mainnet" }),
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("unreadable");
  });

  it("tolerates surrounding whitespace from a paste", () => {
    const out = classifyScannedCard({
      text: `\n  ${encodeContactBundle(BUNDLE)}  \n`,
      myProfileIdHex: MY_ID,
      findExisting: none,
    });
    expect(out.kind).toBe("addable");
  });

  it("never lets a decode throw escape", () => {
    expect(() =>
      classifyScannedCard({ text: "�", myProfileIdHex: null, findExisting: none }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/cemp-core/src/contact-import.test.ts`
Expected: FAIL — cannot resolve `./contact-import.js`

- [ ] **Step 3: Write the implementation**

Create `packages/cemp-core/src/contact-import.ts`:

```ts
/**
 * Classifying a scanned contact card.
 *
 * Pure and RN-free so the whole decision — parse, self, duplicate — is
 * unit-tested on Linux rather than on a phone. The UI's only job is to render
 * the outcome.
 *
 * A scanned card is hostile input (AGENTS.md rule 4): decoding goes through
 * the spec'd `decodeContactBundle`, which rejects unknown protocol/version,
 * wrong network (rule 11), and malformed hex/bech32/fingerprint shapes.
 */

import { decodeContactBundle, type ContactBundleV1 } from "./contact-bundle.js";

export type ScanOutcome =
  | { readonly kind: "addable"; readonly bundle: ContactBundleV1 }
  | { readonly kind: "self"; readonly bundle: ContactBundleV1 }
  | {
      readonly kind: "duplicate";
      readonly bundle: ContactBundleV1;
      readonly existingContactId: number;
    }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Bring a profile id to the database's form: no `0x`, lowercase.
 *
 * The ONE place the prefix asymmetry is resolved. `ContactBundleV1
 * .profileTypeId` is `0x`-prefixed; the contacts table's `profileIdHex` is
 * not. Comparing them unnormalised does not throw — it silently makes every
 * duplicate look new and every self-card look like a stranger.
 */
export function normalizeProfileId(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith("0x") ? lower.slice(2) : lower;
}

export function classifyScannedCard(input: {
  readonly text: string;
  /** This device's own profile id as the database stores it, or null if unpublished. */
  readonly myProfileIdHex: string | null;
  /** Repository lookup, called with the UNPREFIXED id. */
  readonly findExisting: (profileIdHex: string) => { readonly id: number } | undefined;
}): ScanOutcome {
  let bundle: ContactBundleV1;
  try {
    bundle = decodeContactBundle(input.text.trim());
  } catch (e) {
    // The reason is shown to the user, so it must not carry payload content;
    // decodeContactBundle's messages describe the shape fault only.
    return { kind: "unreadable", reason: e instanceof Error ? e.message : "unreadable card" };
  }

  const scanned = normalizeProfileId(bundle.profileTypeId);

  // Self wins over duplicate: if it is your own card, saying so is more useful
  // than pointing at whatever row happens to hold your id.
  if (input.myProfileIdHex !== null && normalizeProfileId(input.myProfileIdHex) === scanned) {
    return { kind: "self", bundle };
  }

  const existing = input.findExisting(scanned);
  if (existing !== undefined) {
    return { kind: "duplicate", bundle, existingContactId: existing.id };
  }
  return { kind: "addable", bundle };
}
```

- [ ] **Step 4: Export it**

Add to `packages/cemp-core/src/index.ts`, beside the other `contact-*` exports:

```ts
export * from "./contact-import.js";
```

- [ ] **Step 5: Run tests and gates**

Run: `npx vitest run packages/cemp-core/src/contact-import.test.ts` — expect all passing.
Then: `npx vitest run` (expect 671 + your new tests), `npm run typecheck`, `npx eslint .`, `npx prettier --check .`

- [ ] **Step 6: Commit**

```bash
git add packages/cemp-core/src/contact-import.ts packages/cemp-core/src/contact-import.test.ts \
        packages/cemp-core/src/index.ts
git commit -m "feat(contacts): classify a scanned contact card (self, duplicate, addable)"
```

---

### Task 2: `CempQrScanner` — still-image decode (photo path)

**Files:**

- Create: `apps/android/src/platform/native-qr-scanner.ts`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/qr/CempQrScannerModule.kt`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/qr/CempQrScannerPackage.kt`
- Modify: `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt`
- Modify: `apps/android/android/app/build.gradle` (ZXing dependency)

**Interfaces:**

- Produces: `scanImageForQr(bytes: Uint8Array): Promise<string | null>` from `native-qr-scanner.ts` — `null` means no code found. Native module `CempQrScanner`, method `scanImage(bytesHex: string): Promise<string | null>`.
- Task 5 consumes `scanImageForQr`. Task 4 adds the iOS half of the same module.

This task ships the photo path alone: no camera, no permission, no preview UI. It is the smaller native surface and proves the seam before the camera lands.

- [ ] **Step 1: Add the ZXing dependency**

In `apps/android/android/app/build.gradle`, beside the other `implementation` lines (near the `exifinterface` entry):

```groovy
    // Pure-Java QR decoding. Deliberately NOT MLKit: no Google Play Services
    // in a privacy-focused messenger, and the card's QR is robust (proven to
    // survive JPEG q40 at 256px in slice 1).
    implementation("com.google.zxing:core:3.5.3")
```

- [ ] **Step 2: Write the JS seam**

Create `apps/android/src/platform/native-qr-scanner.ts`:

```ts
/**
 * QR decoding over the app-local CempQrScanner module.
 *
 * Decoding is native because the JS side never receives raw pixels: the image
 * codec hands back an opaque native bitmap handle by design, so a JS decoder
 * would mean bridging megabytes of RGBA as hex (see the design doc's rejected
 * alternative).
 *
 * Imports react-native, so — per project convention (native-kdf.ts,
 * native-share.ts) — it cannot run under vitest.
 */

import { NativeModules } from "react-native";
import { bytesToHex } from "./hex";

interface CempQrScannerNativeModule {
  /** Decode a still image. Resolves the QR text, or null when none is found. */
  scanImage(bytesHex: string): Promise<string | null>;
}

function module(): CempQrScannerNativeModule {
  const m = NativeModules.CempQrScanner as CempQrScannerNativeModule | undefined;
  if (m === undefined) {
    throw new Error("scanImageForQr: the CempQrScanner native module is not linked");
  }
  return m;
}

export async function scanImageForQr(bytes: Uint8Array): Promise<string | null> {
  return await module().scanImage(bytesToHex(bytes));
}
```

- [ ] **Step 3: Write the Android module**

Create `CempQrScannerModule.kt`:

```kotlin
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
```

`RGBLuminanceSource` takes ARGB ints directly, so no YUV conversion is needed for the still-image path.

- [ ] **Step 4: Write the package class and register it**

Create `CempQrScannerPackage.kt`:

```kotlin
package com.cempmobile.qr

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers {@link CempQrScannerModule} with the React host. */
class CempQrScannerPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CempQrScannerModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
```

In `MainApplication.kt`, add the import for `com.cempmobile.qr.CempQrScannerPackage` and, beside the existing `add(CempSharePackage())`:

```kotlin
          add(CempQrScannerPackage())
```

Registration is two-sided: the package class alone does nothing without this line, and the failure mode is a runtime "not linked" error no build catches.

- [ ] **Step 5: Verify it compiles**

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
cd apps/android/android && ./gradlew :app:assembleDebug --console=plain
```

Expected: `BUILD SUCCESSFUL`. Then confirm the class is really in the output, not merely that the build passed:

```bash
find app/build -name "CempQrScanner*.class"
```

Expected: both `CempQrScannerModule.class` and `CempQrScannerPackage.class`.

- [ ] **Step 6: Run the JS gates and commit**

`npm run typecheck`, `npx eslint .`, `npx prettier --check .`, `npx vitest run` (count unchanged — this task adds no unit-testable surface; say so in your report rather than writing a fake test).

```bash
git add apps/android/src/platform/native-qr-scanner.ts \
        apps/android/android/app/src/main/java/com/cempmobile/qr/ \
        apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt \
        apps/android/android/app/build.gradle
git commit -m "feat(qr): CempQrScanner still-image decode on Android (ZXing)"
```

---

### Task 3: Android camera scanner

**Files:**

- Create: `apps/android/android/app/src/main/java/com/cempmobile/qr/QrScannerActivity.kt`
- Create: `apps/android/android/app/src/main/res/layout/activity_qr_scanner.xml`
- Modify: `apps/android/android/app/src/main/java/com/cempmobile/qr/CempQrScannerModule.kt` (add `scanWithCamera`)
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml` (CAMERA permission + activity)
- Modify: `apps/android/android/app/build.gradle` (CameraX)

**Interfaces:**

- Consumes: the module and package from Task 2.
- Produces: `scanWithCamera(): Promise<string | null>` added to `native-qr-scanner.ts` — `null` on user cancel. Native method `scanWithCamera()`.

- [ ] **Step 1: Add CameraX dependencies**

In `apps/android/android/app/build.gradle`, beside the ZXing line:

```groovy
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
```

- [ ] **Step 2: Declare the permission and the activity**

In `AndroidManifest.xml`, above `<application>`:

```xml
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-feature android:name="android.hardware.camera.any" android:required="false" />
```

Inside `<application>`:

```xml
      <activity
        android:name="com.cempmobile.qr.QrScannerActivity"
        android:exported="false"
        android:theme="@style/Theme.AppCompat.NoActionBar" />
```

- [ ] **Step 3: Add the layout**

Create `res/layout/activity_qr_scanner.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:layout_width="match_parent"
  android:layout_height="match_parent">
  <androidx.camera.view.PreviewView
    android:id="@+id/preview"
    android:layout_width="match_parent"
    android:layout_height="match_parent" />
  <TextView
    android:layout_width="wrap_content"
    android:layout_height="wrap_content"
    android:layout_gravity="center_horizontal|bottom"
    android:layout_marginBottom="48dp"
    android:padding="12dp"
    android:text="Point at a CellSend contact code"
    android:textColor="#ffffff" />
</FrameLayout>
```

- [ ] **Step 4: Write the scanner activity**

Create `QrScannerActivity.kt`. It requests CAMERA if needed, binds a CameraX analyser that feeds luminance frames to ZXing, and finishes with the decoded text in the result intent. Cancel (back press or denied permission) finishes with `RESULT_CANCELED`.

```kotlin
package com.cempmobile.qr

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.cempmobile.R
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

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
```

- [ ] **Step 5: Add `scanWithCamera` to the module**

The activity result can arrive after a process pause, so the module holds the pending promise and listens for activity events. `CempImagePickerModule.kt` solves the identical problem for the photo picker — **read it first and match its conventions**, especially its single-pending-promise guard and how it registers the listener; prefer its form where it differs from the below.

Make the module a `BaseActivityEventListener` and register it in the constructor:

```kotlin
class CempQrScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val REQUEST_CODE = 4802
  }

  private val pending = AtomicReference<Promise?>(null)

  private val activityListener = object : BaseActivityEventListener() {
    override fun onActivityResult(
      activity: Activity?,
      requestCode: Int,
      resultCode: Int,
      data: Intent?,
    ) {
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
  }

  init {
    reactContext.addActivityEventListener(activityListener)
  }

  @ReactMethod
  fun scanWithCamera(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("qr-scan-error", "no activity to present the scanner from")
      return
    }
    // One scan at a time: a second call while one is open would orphan the
    // first promise, leaving JS awaiting forever.
    if (!pending.compareAndSet(null, promise)) {
      promise.reject("qr-scan-error", "a scan is already in progress")
      return
    }
    try {
      activity.startActivityForResult(Intent(activity, QrScannerActivity::class.java), REQUEST_CODE)
    } catch (e: Throwable) {
      pending.compareAndSet(promise, null)
      promise.reject("qr-scan-error", "could not open the scanner", if (e is Exception) e else null)
    }
  }
```

Add the imports: `android.app.Activity`, `android.content.Intent`, `com.facebook.react.bridge.BaseActivityEventListener`, `java.util.concurrent.atomic.AtomicReference`. Keep `scanImage` from Task 2 unchanged in the same class.

Add to `native-qr-scanner.ts`:

```ts
interface CempQrScannerNativeModule {
  scanImage(bytesHex: string): Promise<string | null>;
  /** Present the native camera scanner. Resolves the QR text, or null on cancel. */
  scanWithCamera(): Promise<string | null>;
}

export async function scanWithCamera(): Promise<string | null> {
  return await module().scanWithCamera();
}
```

- [ ] **Step 6: Verify it compiles and commit**

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
cd apps/android/android && ./gradlew :app:assembleDebug --console=plain
```

Expected: `BUILD SUCCESSFUL`. Then confirm the activity is in the merged manifest, since a missing `<activity>` fails only at launch time:

```bash
grep -c "QrScannerActivity" app/build/intermediates/merged_manifests/debug/*/AndroidManifest.xml
```

Expected: at least 1. Run the JS gates, then:

```bash
git add apps/android/android/app/src/main/java/com/cempmobile/qr/ \
        apps/android/android/app/src/main/res/layout/activity_qr_scanner.xml \
        apps/android/android/app/src/main/AndroidManifest.xml \
        apps/android/android/app/build.gradle \
        apps/android/src/platform/native-qr-scanner.ts
git commit -m "feat(qr): Android camera scanner (CameraX + ZXing)"
```

---

### Task 4: iOS scanner — Vision stills and AVFoundation camera

**Files:**

- Create: `apps/android/ios/CempQrScanner/CempQrScanner.m`
- Create: `apps/android/ios/CempQrScanner/CempQrScannerViewController.m`
- Create: `apps/android/ios/scripts/add-qr-scanner.rb`
- Modify: `apps/android/ios/CempMobile/Info.plist` (`NSCameraUsageDescription`)
- Modify: `apps/android/ios/CempMobile.xcodeproj/project.pbxproj` (generated by the script, committed)

**Interfaces:**

- Produces the iOS half of `CempQrScanner`: `scanImage(bytesHex)` and `scanWithCamera()`, matching Tasks 2 and 3's JS seam exactly. No JS changes in this task.

- [ ] **Step 1: Add the camera usage description**

In `apps/android/ios/CempMobile/Info.plist`, beside `NSLocationWhenInUseUsageDescription`:

```xml
	<key>NSCameraUsageDescription</key>
	<string>CellSend uses the camera to scan a contact's QR code. Nothing is recorded or sent.</string>
```

This is mandatory. Its absence is an immediate crash the first time the camera is touched, not a denied-permission dialog.

- [ ] **Step 2: Write the still-image decode**

Create `apps/android/ios/CempQrScanner/CempQrScanner.m` with `RCT_EXPORT_MODULE(CempQrScanner)`, `requiresMainQueueSetup` returning `NO`, a hex-to-`NSData` helper matching the one in `CempShare.m`, and:

```objc
RCT_EXPORT_METHOD(scanImage:(NSString *)bytesHex
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *data = DataFromHex(bytesHex);
  if (data == nil) {
    reject(@"qr-decode-error", @"image payload was not valid hex", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    CIImage *image = [CIImage imageWithData:data];
    if (image == nil) {
      reject(@"qr-decode-error", @"could not read that image", nil);
      return;
    }
    VNDetectBarcodesRequest *request = [[VNDetectBarcodesRequest alloc] init];
    request.symbologies = @[ VNBarcodeSymbologyQR ];
    VNImageRequestHandler *handler =
        [[VNImageRequestHandler alloc] initWithCIImage:image options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[ request ] error:&error]) {
      reject(@"qr-decode-error", @"could not scan that image", error);
      return;
    }
    for (VNBarcodeObservation *obs in request.results) {
      if (obs.payloadStringValue.length > 0) {
        resolve(obs.payloadStringValue);
        return;
      }
    }
    // No code found is a normal outcome, not an error.
    resolve(nil);
  });
}
```

Import `<Vision/Vision.h>` and `<CoreImage/CoreImage.h>`.

- [ ] **Step 3: Write the camera scanner view controller**

Create `CempQrScannerViewController.m` — an `AVCaptureSession` with `AVCaptureMetadataOutput` restricted to QR, a full-screen preview layer, and a Cancel button. The completion block fires exactly once, with the decoded string or `nil` for cancel:

```objc
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

@interface CempQrScannerViewController : UIViewController <AVCaptureMetadataOutputObjectsDelegate>
@property (nonatomic, copy) void (^onResult)(NSString *_Nullable);
@end

@implementation CempQrScannerViewController {
  AVCaptureSession *_session;
  AVCaptureVideoPreviewLayer *_preview;
  BOOL _finished;
}

- (void)viewDidLoad
{
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;

  _session = [[AVCaptureSession alloc] init];
  AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  if (input == nil || ![_session canAddInput:input]) {
    // No usable camera (simulator, hardware fault) is a cancel, not a crash.
    [self finishWith:nil];
    return;
  }
  [_session addInput:input];

  AVCaptureMetadataOutput *output = [[AVCaptureMetadataOutput alloc] init];
  [_session addOutput:output];
  [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
  output.metadataObjectTypes = @[ AVMetadataObjectTypeQRCode ];

  _preview = [AVCaptureVideoPreviewLayer layerWithSession:_session];
  _preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
  _preview.frame = self.view.layer.bounds;
  [self.view.layer addSublayer:_preview];

  UIButton *cancel = [UIButton buttonWithType:UIButtonTypeSystem];
  [cancel setTitle:@"Cancel" forState:UIControlStateNormal];
  [cancel setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
  [cancel addTarget:self action:@selector(cancelTapped) forControlEvents:UIControlEventTouchUpInside];
  cancel.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:cancel];
  [NSLayoutConstraint activateConstraints:@[
    [cancel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [cancel.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor
                                        constant:-24],
  ]];
}

- (void)viewDidAppear:(BOOL)animated
{
  [super viewDidAppear:animated];
  // startRunning blocks; keep it off the main queue.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self->_session startRunning];
  });
}

- (void)viewDidLayoutSubviews
{
  [super viewDidLayoutSubviews];
  _preview.frame = self.view.layer.bounds;
}

- (void)cancelTapped
{
  [self finishWith:nil];
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objects
              fromConnection:(AVCaptureConnection *)connection
{
  for (AVMetadataObject *object in objects) {
    if (![object isKindOfClass:[AVMetadataMachineReadableCodeObject class]]) {
      continue;
    }
    NSString *value = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
    if (value.length > 0) {
      [self finishWith:value];
      return;
    }
  }
}

/** Fires onResult exactly once, whatever path got here. */
- (void)finishWith:(NSString *_Nullable)text
{
  if (_finished) {
    return;
  }
  _finished = YES;
  [_session stopRunning];
  void (^handler)(NSString *_Nullable) = self.onResult;
  self.onResult = nil;
  if (handler != nil) {
    handler(text);
  }
}

@end
```

Declare the class in a header or use a small `CempQrScannerViewController.h` so `CempQrScanner.m` can import it; if you add a header, include it in the ruby script's file list too.

Present it from `scanWithCamera` on the main queue via `RCTPresentedViewController()`, and resolve the promise from the completion block — resolving exactly once, with `nil` for cancel:

```objc
RCT_EXPORT_METHOD(scanWithCamera:(RCTPromiseResolveBlock)resolve
                        rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = RCTPresentedViewController();
    if (presenter == nil) {
      reject(@"qr-scan-error", @"no view controller to present from", nil);
      return;
    }
    CempQrScannerViewController *vc = [[CempQrScannerViewController alloc] init];
    vc.onResult = ^(NSString *_Nullable text) {
      [presenter dismissViewControllerAnimated:YES completion:^{
        resolve(text);
      }];
    };
    [presenter presentViewController:vc animated:YES completion:nil];
  });
}
```

- [ ] **Step 4: Wire the Xcode target**

iOS sources do NOT reach the app target automatically. Read `apps/android/ios/scripts/add-share.rb` — slice 1's script, the proven pattern — and write `add-qr-scanner.rb` following it, adding both `.m` files. Then:

```bash
export GEM_HOME=$(ruby -e 'puts Gem.user_dir')
export PATH="$GEM_HOME/bin:$PATH"
cd apps/android/ios && ruby scripts/add-qr-scanner.rb
```

The `xcodeproj` gem is installed standalone (the scripts' "ships with CocoaPods" note applies to macOS only).

**Verify build-phase membership, not a grep count.** A grep count is meaningless here — single-file modules legitimately show few hits. Run:

```bash
ruby -e '
require "xcodeproj"
pr = Xcodeproj::Project.open("CempMobile.xcodeproj")
t = pr.targets.find { |x| x.name == "CempMobile" }
puts t.source_build_phase.files_references.map { |r| r.path.to_s }
'
```

Expected: both `CempQrScanner.m` and `CempQrScannerViewController.m` listed.

- [ ] **Step 5: Prove it compiles on a macOS runner**

```bash
gh workflow run ios-build.yml --ref <branch> -f mode=validate
```

Push the branch first — CI builds the **remote** ref, and building a stale ref produces an artifact that looks fine and lacks your work.

- [ ] **Step 6: Commit**

```bash
git add apps/android/ios/CempQrScanner/ apps/android/ios/scripts/add-qr-scanner.rb \
        apps/android/ios/CempMobile/Info.plist \
        apps/android/ios/CempMobile.xcodeproj/project.pbxproj
git commit -m "feat(qr): iOS scanner — Vision stills and AVFoundation camera"
```

---

### Task 5: Scan-contact screen

**Files:**

- Create: `apps/android/src/screens/scan-contact-screen.tsx`
- Modify: `apps/android/src/navigation.ts` (add `ScanContact` route)
- Modify: `apps/android/src/App.tsx` (register the screen)
- Modify: `apps/android/src/screens/contacts-screen.tsx` (entry point)

**Interfaces:**

- Consumes: `classifyScannedCard`, `normalizeProfileId`, `type ScanOutcome` from `@cemp/core` (Task 1); `scanImageForQr`, `scanWithCamera` from `../platform/native-qr-scanner` (Tasks 2–3); `pickImage` from `../platform/native-image-picker` (existing); `container.repositories.contacts` (`getByProfileId`, `create`); `container.messaging.myProfileId()`.

- [ ] **Step 1: Add the container passthroughs**

The screen must not import platform modules directly — the share seam precedent in `app-container.ts` routes them through the container. Add beside `shareContactCard`:

```ts
  /** Present the native camera scanner. Null on cancel. */
  async scanContactWithCamera(): Promise<string | null> {
    return await scanWithCamera();
  }

  /** Let the user pick a photo and decode a QR from it. Null if none found or cancelled. */
  async scanContactFromPhoto(): Promise<string | null> {
    const bytes = await pickImage();
    if (bytes === null) {
      return null;
    }
    return await scanImageForQr(bytes);
  }
```

with the matching imports.

- [ ] **Step 2: Write the screen**

Create `apps/android/src/screens/scan-contact-screen.tsx`. Requirements, each a distinct rendered state:

1. Three inputs, each producing the scanned text then handing it to `classifyScannedCard`:
   - **Scan with camera** → `container.scanContactWithCamera()`
   - **Scan from photo** → `container.scanContactFromPhoto()`
   - a paste box + **Use pasted code** → the text box value directly

   All three converge on one handler:

   All three converge on one handler. Note the deliberate shape: `classifyScannedCard` is **synchronous** so it stays pure and fully unit-tested, but `getByProfileId` is **async**. Do NOT make `findExisting` async to paper over this — that would drag I/O into the tested core. Instead classify first with a `findExisting` that always returns `undefined`, then do the repository lookup only for an `addable` outcome and downgrade it yourself:

   ```ts
   async function handleScanned(text: string | null): Promise<void> {
     if (text === null) {
       return; // cancel, or no code in the image — a normal outcome, not an error
     }
     const myProfileIdHex = container.hasMessaging ? await container.messaging.myProfileId() : null;

     // Pass 1: pure classification. self / unreadable are fully decided here.
     const outcome = classifyScannedCard({
       text,
       myProfileIdHex,
       findExisting: () => undefined,
     });

     // Pass 2: only an addable card needs the database consulted.
     if (outcome.kind === "addable") {
       const existing = await container.repositories.contacts.getByProfileId(
         normalizeProfileId(outcome.bundle.profileTypeId),
       );
       if (existing !== undefined) {
         setResult({ kind: "duplicate", bundle: outcome.bundle, existingContactId: existing.id });
         return;
       }
     }
     setResult(outcome);
   }
   ```

   Self-detection needs no I/O beyond `myProfileId()`, which is why it is decided in pass 1.

2. Each async action gets **its own** try/catch and its own message. Do not share one catch across the scan and the classification — the repo has been burned twice by conflated catches (see `unlock-screen.tsx:32-60`), and a scanner failure is not a decode failure.
3. On `kind: "addable"` — show the fingerprint and network, a **required** name field, and a Save button. Save calls `contacts.create({ displayName, profileIdHex })` with the **normalised** (unprefixed) id, then `navigation.goBack()`.
4. On `kind: "self"` — show "That's your own card", **plus the parsed fingerprint and network**, and no Save. This makes a self-scan a real end-to-end decode test on one phone (owner decision, 2026-07-30).
5. On `kind: "duplicate"` — show that the contact already exists and offer a button opening it via `navigation.navigate("ContactEdit", { contactId })`. Never create a second row.
6. On `kind: "unreadable"` — show an honest message. Map the reason to plain language: not a CellSend code, a newer version, a different network, or a damaged code. Never render raw decoder text as the primary message.
7. Cancel (camera dismissed, no photo chosen, no code in the image) shows **no error** — `null` is a normal outcome.
8. Buttons disabled while an action is in flight.

Follow `my-card-screen.tsx` for structure and `contacts-screen.tsx` for navigation typing.

- [ ] **Step 3: Register navigation and the entry point**

In `navigation.ts`, add to `RootStackParamList`:

```ts
ScanContact: undefined;
```

In `App.tsx`, import `ScanContactScreen` beside the other screen imports and register it after the `MyCard` entry:

```tsx
<Stack.Screen
  name="ScanContact"
  component={ScanContactScreen}
  options={{ title: "Add by QR code" }}
/>
```

In `contacts-screen.tsx`, beside the "My contact card" button:

```tsx
<Button title="Add by QR code" onPress={() => navigation.navigate("ScanContact")} />
```

- [ ] **Step 4: Run gates and commit**

`npm run typecheck`, `npx eslint .`, `npx prettier --check .`, `npx vitest run`. The suite count will not change — this screen imports `react-native` and cannot run under vitest, which is exactly why Task 1 holds the logic. State that in your report rather than writing a fake test.

```bash
git add apps/android/src/screens/scan-contact-screen.tsx apps/android/src/navigation.ts \
        apps/android/src/App.tsx apps/android/src/screens/contacts-screen.tsx \
        apps/android/src/app-container.ts
git commit -m "feat(contacts): scan a contact card by camera, photo or paste"
```

---

### Task 6: Device verification

**Files:** none — this task produces evidence and a record.

Not optional. Every classification path is unit-tested, but the camera, the photo picker, the permission dialogs and the two native decoders are not, and unverified native seams are what shipped the vault database bug on 2026-07-29.

- [ ] **Step 1: Build and install**

Push the branch, then:

```bash
gh workflow run ios-build.yml --ref <branch> -f mode=device
```

Push first — CI builds the remote ref. Download the artifact, then **verify the bundle contains the new UI before installing**, because a stale ref produces an installable IPA that silently lacks the feature:

```bash
python3 -c "
d=open('Payload/CempMobile.app/main.jsbundle','rb').read()
for s in ['Add by QR code','Scan with camera','Scan from photo','Use pasted code']:
    print(s, d.count(s.encode()) or d.count(s.encode('utf-16-le')))
"
```

Then `xtool install <ipa>`.

- [ ] **Step 2: Self-scan (the single-phone end-to-end test)**

Open **My contact card**, then from another device or a second window scan your own card — or screenshot it, then use **Scan from photo** on the screenshot.
Expected: "That's your own card" **with** the parsed fingerprint and network shown, and no contact created. This proves decode without a second identity.

- [ ] **Step 3: Camera permission, both outcomes**

First camera use must show the OS permission prompt. **Deny it** — expected: the screen returns with no error and the photo/paste options still work, no crash. Then grant it and confirm the preview appears.

- [ ] **Step 4: Add a real contact**

Using a second device or a card someone sends you, scan and save. Confirm the contact appears in Contacts with the name you typed, and that its stored id matches the card's `profileTypeId` without the `0x`.

- [ ] **Step 5: Duplicate**

Scan the same card again. Expected: the "already exists" state with a button opening the existing contact — and no second row in Contacts.

- [ ] **Step 6: The recompressed-photo path**

Have the card sent to you through Telegram or WhatsApp, save the image, and use **Scan from photo** on the saved copy. Slice 1 proved the QR survives JPEG q40 at 256 px under ZBar; this proves our own decoders handle it too.

- [ ] **Step 7: Wrong-network refusal**

If a mainnet-network bundle can be produced by hand, paste it and confirm it is refused as a different network (AGENTS.md rule 11). If it cannot be produced, say so in the report rather than claiming the check passed.

- [ ] **Step 8: Record the result**

Append to `.superpowers/sdd/progress.md`: the build number, each step's outcome, and anything left unverified. Commit.

---

## What slice 2 deliberately excludes

Deep-link handling (no URL scheme registration; the paste box covers the fallback), in-app contact-card messages, third-party introductions, and avatars in the card. Slice 1's non-goals still stand.
