/*
 * CempHeadlessTask — React Native bridge module letting the headless JS
 * task report completion, the iOS counterpart of the Android
 * CempHeadlessTaskModule. The JS-facing surface is identical
 * (apps/android/src/platform/headless-task.ts):
 *
 *   NativeModules.CempHeadlessTask.notifyTaskFinished(tickId)
 *
 * Fire-and-forget on purpose (no Promise, like Kotlin): the JS caller has
 * nothing left to do with an answer, and the unknown/already-finished case
 * is a no-op inside the engine. The signal completes every BGTask under the
 * scheduler engine's bookkeeping with success — see CempScheduler.m for the
 * invocation design.
 */

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#import "CempScheduler.h"
#import "CempSchedulerEngine.h"

@interface CempHeadlessTask : NSObject <RCTBridgeModule>
@end

@implementation CempHeadlessTask

RCT_EXPORT_MODULE(CempHeadlessTask);

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(notifyTaskFinished:(nonnull NSNumber *)tickId)
{
  // The tick id correlates a JS run with native bookkeeping; it carries no
  // user data. Unknown/already-finished is a harmless no-op (engine).
  [CempSchedulerSharedEngine() notifyTickFinished];
}

@end
