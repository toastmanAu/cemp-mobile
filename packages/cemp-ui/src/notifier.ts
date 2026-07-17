/**
 * Notification boundary (spec Phase 6 task 12).
 *
 * The shell never touches Android notification APIs directly; it posts
 * through {@link Notifier}. The Android implementation (NotificationManager
 * with the channels below) ships with the app bootstrap; {@link NoopNotifier}
 * serves headless runs and tests. Channel ids are stable — they are user-
 * visible in Android system settings once created.
 */

/** Android notification channel mapping the native impl must create. */
export const NOTIFICATION_CHANNELS = [
  {
    id: "messages",
    displayName: "Messages",
    importance: "high",
    description: "Incoming CEMP messages",
  },
  {
    id: "sync-status",
    displayName: "Sync status",
    importance: "low",
    description: "Background synchronisation progress and failures",
  },
] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number]["id"];

export interface NotificationContent {
  /** Stable id so updates replace rather than stack. */
  readonly id: string;
  readonly channel: NotificationChannelId;
  readonly title: string;
  readonly body: string;
}

export interface Notifier {
  post(content: NotificationContent): Promise<void>;
  cancel(id: string): Promise<void>;
}

/** Silent reference implementation (headless runs, tests). */
export class NoopNotifier implements Notifier {
  post(_content: NotificationContent): Promise<void> {
    return Promise.resolve();
  }

  cancel(_id: string): Promise<void> {
    return Promise.resolve();
  }
}
