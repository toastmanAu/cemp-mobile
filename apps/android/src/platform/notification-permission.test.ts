import { describe, expect, it } from "vitest";
import { requiresNotificationPermissionRequest } from "./notification-permission";

describe("requiresNotificationPermissionRequest", () => {
  it("is false off Android entirely", () => {
    expect(requiresNotificationPermissionRequest("ios", "17")).toBe(false);
  });

  it("is false on Android below API 33", () => {
    expect(requiresNotificationPermissionRequest("android", "32")).toBe(false);
    expect(requiresNotificationPermissionRequest("android", 28)).toBe(false);
  });

  it("is true on Android 13 (API 33) and above", () => {
    expect(requiresNotificationPermissionRequest("android", "33")).toBe(true);
    expect(requiresNotificationPermissionRequest("android", 34)).toBe(true);
  });

  it("treats the Android API level boundary as inclusive", () => {
    expect(requiresNotificationPermissionRequest("android", 33)).toBe(true);
  });
});
