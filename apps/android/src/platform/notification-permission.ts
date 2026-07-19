/**
 * Whether the running platform requires the runtime `POST_NOTIFICATIONS`
 * grant (Android 13 / API 33+ — targetSdk 33+ apps only, per the platform
 * behavior change). Pulled out of `android-notifier.ts` (which imports
 * `react-native` and so cannot run under vitest) so the version-gate logic
 * is unit-tested directly; the react-native file stays a thin pass-through
 * that only calls this and, if true, `PermissionsAndroid.request`.
 */
export function requiresNotificationPermissionRequest(
  osName: string,
  osVersion: string | number,
): boolean {
  return osName === "android" && Number(osVersion) >= 33;
}
