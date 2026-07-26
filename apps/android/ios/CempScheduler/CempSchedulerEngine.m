/* See CempSchedulerEngine.h for the behaviour contract. */

#import "CempSchedulerEngine.h"

NSString *const CempSchedulerPeriodicIdentifier = @"com.cempmobile.sync.tick";
NSString *const CempSchedulerOneShotIdentifier = @"com.cempmobile.sync.oneshot";

NS_ASSUME_NONNULL_BEGIN

@implementation CempSchedulerEngine {
  id<CempSchedulerTaskGateway> _gateway;
  NSLock *_lock;
  NSInteger _lastTickId;
  // Handles of fired tasks awaiting a JS finish signal (or expiration).
  NSMutableArray<id<CempSchedulerTaskHandle>> *_pendingHandles;
  // Last submitted periodic params — iOS "periodicity" is resubmission.
  BOOL _hasPeriodicParams;
  double _periodicIntervalMs;
  BOOL _periodicRequiresNetwork;
}

- (instancetype)initWithGateway:(id<CempSchedulerTaskGateway>)gateway {
  self = [super init];
  if (self) {
    _gateway = gateway;
    _lock = [[NSLock alloc] init];
    _pendingHandles = [NSMutableArray array];
  }
  return self;
}

#pragma mark - Scheduling

- (BOOL)submitPeriodicWithIntervalMs:(double)intervalMs
                     requiresNetwork:(BOOL)requiresNetwork
                               error:(NSError **)error {
  BGAppRefreshTaskRequest *request = [[BGAppRefreshTaskRequest alloc]
      initWithIdentifier:CempSchedulerPeriodicIdentifier];
  request.earliestBeginDate =
      [NSDate dateWithTimeIntervalSinceNow:intervalMs / 1000.0];
  // NOTE: BGAppRefreshTaskRequest has no network/power constraint (only
  // BGProcessingTaskRequest does) — the WorkManager requiresNetwork flag has
  // no iOS mapping for the periodic tick; it is stored for the resubmission
  // path but not applied. The OS decides the cadence (ios-prep Task 3).
  BOOL submitted = [_gateway submitTaskRequest:request error:error];
  if (submitted) {
    [_lock lock];
    _hasPeriodicParams = YES;
    _periodicIntervalMs = intervalMs;
    _periodicRequiresNetwork = requiresNetwork;
    [_lock unlock];
  }
  return submitted;
}

- (void)schedulePeriodicWithIntervalMs:(double)intervalMs
                       requiresNetwork:(BOOL)requiresNetwork
                       replaceExisting:(BOOL)replaceExisting
                            completion:(void (^)(NSError *_Nullable error))completion {
  if (replaceExisting) {
    // UPDATE: submitting with the same identifier replaces the pending one.
    NSError *error = nil;
    [self submitPeriodicWithIntervalMs:intervalMs
                       requiresNetwork:requiresNetwork
                                 error:&error];
    completion(error);
    return;
  }
  // KEEP: an already-pending tick retains its schedule.
  [_gateway pendingTaskIdentifiers:^(NSSet<NSString *> *identifiers) {
    if ([identifiers containsObject:CempSchedulerPeriodicIdentifier]) {
      completion(nil);
      return;
    }
    NSError *error = nil;
    [self submitPeriodicWithIntervalMs:intervalMs
                       requiresNetwork:requiresNetwork
                                 error:&error];
    completion(error);
  }];
}

- (void)scheduleOneShotWithIdentifier:(NSString *)identifier
                              delayMs:(double)delayMs
                           completion:(void (^)(NSError *_Nullable error))completion {
  BGProcessingTaskRequest *request = [[BGProcessingTaskRequest alloc]
      initWithIdentifier:CempSchedulerOneShotIdentifier];
  request.earliestBeginDate =
      [NSDate dateWithTimeIntervalSinceNow:delayMs / 1000.0];
  // Matches the Kotlin one-shot constraints (NetworkType.CONNECTED); the
  // retry a processing task represents is worthless without the network.
  request.requiresNetworkConnectivity = YES;
  request.requiresExternalPower = NO;
  NSError *error = nil;
  [_gateway submitTaskRequest:request error:&error];
  completion(error);
}

- (void)cancelWithIdentifier:(NSString *)identifier {
  [_gateway cancelTaskRequestWithIdentifier:CempSchedulerOneShotIdentifier];
}

- (void)cancelPeriodic {
  [_gateway cancelTaskRequestWithIdentifier:CempSchedulerPeriodicIdentifier];
}

#pragma mark - Tick bookkeeping

- (NSInteger)nextTickId {
  [_lock lock];
  NSInteger tickId = ++_lastTickId;
  [_lock unlock];
  return tickId;
}

- (void)taskDidFire:(id<CempSchedulerTaskHandle>)handle
     withIdentifier:(NSString *)identifier {
  [_lock lock];
  [_pendingHandles addObject:handle];
  [_lock unlock];

  __weak CempSchedulerEngine *weakSelf = self;
  __weak id<CempSchedulerTaskHandle> weakHandle = handle;
  handle.expirationHandler = ^{
    // Out of background time with no JS finish signal: complete with
    // failure so the system does not kill the app mid-task. (weakHandle:
    // the handle owns this block — a strong capture would be a cycle.)
    [weakSelf completeHandle:weakHandle withSuccess:NO];
  };

  if ([identifier isEqualToString:CempSchedulerPeriodicIdentifier]) {
    // iOS refresh tasks are one-shot: resubmit the next occurrence to
    // emulate the periodic tick (best-effort — the OS owns the cadence).
    [_lock lock];
    BOOL hasParams = _hasPeriodicParams;
    double intervalMs = _periodicIntervalMs;
    BOOL requiresNetwork = _periodicRequiresNetwork;
    [_lock unlock];
    if (hasParams) {
      NSError *error = nil;
      [self submitPeriodicWithIntervalMs:intervalMs
                         requiresNetwork:requiresNetwork
                                   error:&error];
      (void)error; // best-effort; the next unlock re-registers anyway
    }
  }
}

/* Complete a tracked handle exactly once. */
- (void)completeHandle:(id<CempSchedulerTaskHandle>)handle
           withSuccess:(BOOL)success {
  [_lock lock];
  BOOL tracked = [_pendingHandles containsObject:handle];
  if (tracked) {
    [_pendingHandles removeObject:handle];
  }
  [_lock unlock];
  if (tracked) {
    [handle markTaskCompletedWithSuccess:success];
  }
}

- (void)notifyTickFinished {
  [_lock lock];
  NSArray<id<CempSchedulerTaskHandle>> *handles = [_pendingHandles copy];
  [_pendingHandles removeAllObjects];
  [_lock unlock];
  for (id<CempSchedulerTaskHandle> handle in handles) {
    [handle markTaskCompletedWithSuccess:YES];
  }
}

@end

NS_ASSUME_NONNULL_END
