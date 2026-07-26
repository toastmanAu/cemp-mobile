/* See CempScheduler.h for the contract and the JS invocation design. */

#import "CempScheduler.h"

#import <BackgroundTasks/BackgroundTasks.h>

#import "CempSchedulerEngine.h"

NS_ASSUME_NONNULL_BEGIN

#pragma mark - BGTaskScheduler gateway

/* CempSchedulerTaskGateway over the real BGTaskScheduler. */
@interface CempBGTaskSchedulerGateway : NSObject <CempSchedulerTaskGateway>
@end

@implementation CempBGTaskSchedulerGateway

- (void)pendingTaskIdentifiers:(void (^)(NSSet<NSString *> *))completion {
  [BGTaskScheduler.sharedScheduler
      getPendingTaskRequestsWithCompletionHandler:^(NSArray<BGTaskRequest *> *requests) {
    NSMutableSet<NSString *> *identifiers = [NSMutableSet set];
    for (BGTaskRequest *request in requests) {
      [identifiers addObject:request.identifier];
    }
    completion(identifiers);
  }];
}

- (BOOL)submitTaskRequest:(BGTaskRequest *)request error:(NSError **)error {
  return [BGTaskScheduler.sharedScheduler submitTaskRequest:request
                                                      error:error];
}

- (void)cancelTaskRequestWithIdentifier:(NSString *)identifier {
  [BGTaskScheduler.sharedScheduler cancelTaskRequestWithIdentifier:identifier];
}

@end

#pragma mark - BGTask handle adapter

/* CempSchedulerTaskHandle over a real BGTask. */
@interface CempBGTaskHandle : NSObject <CempSchedulerTaskHandle>
- (instancetype)initWithTask:(BGTask *)task;
@end

@implementation CempBGTaskHandle {
  BGTask *_task;
}

- (instancetype)initWithTask:(BGTask *)task {
  self = [super init];
  if (self) {
    _task = task;
  }
  return self;
}

- (void (^ _Nullable)(void))expirationHandler {
  return _task.expirationHandler;
}

- (void)setExpirationHandler:(void (^ _Nullable)(void))handler {
  _task.expirationHandler = handler;
}

- (void)markTaskCompletedWithSuccess:(BOOL)success {
  [_task setTaskCompletedWithSuccess:success];
}

@end


#pragma mark - Shared engine

/** The shared engine: one scheduling state for module instance + BGTask handlers. */
static CempSchedulerEngine *SharedEngine(void) {
  static CempSchedulerEngine *engine = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    engine = [[CempSchedulerEngine alloc] initWithGateway:
        [[CempBGTaskSchedulerGateway alloc] init]];
  });
  return engine;
}

/** Engine-facing access for CempHeadlessTask (same module group). */
CempSchedulerEngine *CempSchedulerSharedEngine(void) {
  return SharedEngine();
}

#pragma mark - Bridge module

@implementation CempScheduler

RCT_EXPORT_MODULE(CempScheduler);

/* The live module instance, for the launch handler's JS delivery check.
 * Weak: RN owns the module lifecycle. */
static __weak CempScheduler *ActiveInstance = nil;

@synthesize callableJSModules = _callableJSModules;

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    ActiveInstance = self;
  }
  return self;
}

+ (void)registerBackgroundTasks
{
  CempSchedulerEngine *engine = SharedEngine();
  NSArray<NSString *> *identifiers =
      @[ CempSchedulerPeriodicIdentifier, CempSchedulerOneShotIdentifier ];
  for (NSString *identifier in identifiers) {
    // nil queue = main queue; the handlers are cheap (delivery + bookkeeping).
    [BGTaskScheduler.sharedScheduler
        registerForTaskWithIdentifier:identifier
                           usingQueue:nil
                        launchHandler:^(BGTask *task) {
      [self handleBackgroundTask:task engine:engine];
    }];
  }
}

+ (void)handleBackgroundTask:(BGTask *)task
                      engine:(CempSchedulerEngine *)engine
{
  CempBGTaskHandle *handle =
      [[CempBGTaskHandle alloc] initWithTask:task];
  // Bookkeeping + expiration wiring + periodic resubmission.
  [engine taskDidFire:handle withIdentifier:task.identifier];

  RCTCallableJSModules *jsModules = ActiveInstance.callableJSModules;
  if (jsModules == nil) {
    // No reachable JS runtime: complete natively, immediately. Background
    // slots are accelerators; foreground catch-up owns correctness.
    [handle markTaskCompletedWithSuccess:YES];
    return;
  }
  NSInteger tickId = [engine nextTickId];
  // The same entry the Android CempSyncWorker invokes. NOTE: index.js
  // currently registers "CempBackgroundSync" on Android only (Platform.OS
  // seam, 5e6ca11) — until that guard covers iOS, the invocation warns and
  // returns without running the tick. The grace completion below is what
  // settles the task in that state (no JS signal ever arrives).
  [jsModules invokeModule:@"AppRegistry"
                   method:@"startHeadlessTask"
                 withArgs:@[
                   @(tickId),
                   @"CempBackgroundSync",
                   @{@"tickId" : @(tickId)},
                 ]];
  // Grace completion (the Kotlin worker's timeout-grace analogue): if no JS
  // finish signal arrives within the grace window — wedged runtime, JS
  // bundle failed to load, or no task registered — settle natively with
  // success instead of burning the OS budget to expiration (a failure mark
  // would only throttle future best-effort slots; foreground catch-up owns
  // correctness either way). A JS signal that already arrived makes this a
  // no-op (the engine's bookkeeping is empty by then).
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(30 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    [engine notifyTickFinished];
  });
}

static void SettleEngineCall(void (^call)(void (^)(NSError *)),
                             RCTPromiseResolveBlock resolve,
                             RCTPromiseRejectBlock reject)
{
  call(^(NSError *error) {
    if (error != nil) {
      reject(@"scheduler_error", @"could not schedule background work", error);
    } else {
      resolve(nil);
    }
  });
}

RCT_EXPORT_METHOD(schedulePeriodic:(nonnull NSNumber *)intervalMs
                  requiresNetwork:(BOOL)requiresNetwork
                  replaceExisting:(BOOL)replaceExisting
                         resolver:(RCTPromiseResolveBlock)resolve
                         rejecter:(RCTPromiseRejectBlock)reject)
{
  SettleEngineCall(^(void (^done)(NSError *)) {
    [SharedEngine() schedulePeriodicWithIntervalMs:intervalMs.doubleValue
                                   requiresNetwork:requiresNetwork
                                   replaceExisting:replaceExisting
                                        completion:done];
  }, resolve, reject);
}

RCT_EXPORT_METHOD(scheduleOneShot:(NSString *)identifier
                         delayMs:(nonnull NSNumber *)delayMs
                        resolver:(RCTPromiseResolveBlock)resolve
                        rejecter:(RCTPromiseRejectBlock)reject)
{
  SettleEngineCall(^(void (^done)(NSError *)) {
    [SharedEngine() scheduleOneShotWithIdentifier:identifier
                                          delayMs:delayMs.doubleValue
                                       completion:done];
  }, resolve, reject);
}

RCT_EXPORT_METHOD(cancel:(NSString *)identifier
                resolver:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject)
{
  [SharedEngine() cancelWithIdentifier:identifier];
  resolve(nil);
}

RCT_EXPORT_METHOD(cancelPeriodic:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject)
{
  [SharedEngine() cancelPeriodic];
  resolve(nil);
}

@end

NS_ASSUME_NONNULL_END
