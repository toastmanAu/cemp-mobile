/**
 * {@link Notifier} over the app-local CempNotifier Kotlin module
 * (android/app/src/main/java/com/cempmobile/background).
 *
 * Notification delivery is best-effort: if the user denied POST_NOTIFICATIONS
 * the native module resolves silently rather than rejecting, because a missing
 * notification must never fail a sync tick.
 *
 * Imports react-native, so this file cannot run under vitest (project rule);
 * it stays a thin pass-through with no logic of its own. The Android-version
 * gate for the runtime permission request lives in the RN-free
 * `notification-permission.ts`, where it is unit-tested directly.
 */

import { PermissionsAndroid, Platform, NativeModules } from "react-native";
import type { NotificationContent, Notifier } from "@cemp/ui";
import { requiresNotificationPermissionRequest } from "./notification-permission";

interface CempNotifierNativeModule {
  post(id: string, channel: string, title: string, body: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

export class AndroidNotifier implements Notifier {
  #module(): CempNotifierNativeModule {
    const module = NativeModules.CempNotifier as CempNotifierNativeModule | undefined;
    if (module === undefined) {
      throw new Error("AndroidNotifier: the CempNotifier native module is not linked");
    }
    return module;
  }

  async post(content: NotificationContent): Promise<void> {
    await this.#module().post(content.id, content.channel, content.title, content.body);
  }

  async cancel(id: string): Promise<void> {
    await this.#module().cancel(id);
  }
}

/**
 * Android 13+ requires a runtime grant. Called once after unlock; a refusal is
 * not an error — notifications are simply dropped afterwards.
 */
export async function requestNotificationPermission(): Promise<void> {
  if (!requiresNotificationPermissionRequest(Platform.OS, Platform.Version)) {
    return;
  }
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}
