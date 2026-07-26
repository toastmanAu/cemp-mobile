/*
 * CempScheduler — React Native bridge module for background sync scheduling,
 * the iOS counterpart of the Android CempSchedulerModule (WorkManager). The
 * JS-facing surface is identical
 * (apps/android/src/platform/work-manager-scheduler.ts):
 *
 *   NativeModules.CempScheduler.schedulePeriodic(intervalMs, requiresNetwork, replaceExisting)
 *   NativeModules.CempScheduler.scheduleOneShot(id, delayMs)
 *   NativeModules.CempScheduler.cancel(id)
 *   NativeModules.CempScheduler.cancelPeriodic()
 *     -> Promise<void>   (rejects with "scheduler_error" like Kotlin)
 *
 * All scheduling semantics live in CempSchedulerEngine (XCTest-proven in
 * CempMobileTests/CempSchedulerTests.m). This shell owns the BGTaskScheduler
 * boundary: task registration (+registerBackgroundTasks, called from the
 * AppDelegate before the app finishes launching) and the JS tick delivery.
 *
 * BACKGROUND-JS INVOCATION (the honest v1): iOS has no HeadlessJS. When a
 * BGTask fires the launch handler mints a tick id and, if the JS runtime is
 * reachable (callableJSModules present), invokes the SAME entry the Android
 * worker invokes — AppRegistry.startHeadlessTask(tickId,
 * "CempBackgroundSync", {tickId}) — which index.js already registers, so
 * apps/android/src needs no iOS branch. JS signals completion through the
 * CempHeadlessTask module (same as Android), which completes the BGTask.
 * If the runtime is NOT reachable the task is completed natively,
 * immediately: background slots are best-effort accelerators and FOREGROUND
 * CATCH-UP owns correctness (ios-prep.md Task 3). A BGTask launch of a cold
 * app still boots RN from AppDelegate — in a DEBUG build without Metro the
 * JS load fails and the immediate-completion path applies; v1 deliberately
 * does not try to make cold-boot delivery reliable. Errors carry static
 * strings only (AGENTS.md rule 2).
 */

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

@class CempSchedulerEngine;

/** The shared scheduling engine (module instance + BGTask handlers). */
CempSchedulerEngine *CempSchedulerSharedEngine(void);

@interface CempScheduler : NSObject <RCTBridgeModule>

/**
 * Register the BGTask launch handlers (both identifiers). MUST be called
 * from application(_:didFinishLaunchingWithOptions:) before the app
 * finishes launching — the system throws otherwise.
 */
+ (void)registerBackgroundTasks;

@end

NS_ASSUME_NONNULL_END
