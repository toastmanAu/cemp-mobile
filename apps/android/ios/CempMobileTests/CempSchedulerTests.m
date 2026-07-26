/*
 * CempSchedulerTests — headless engine tests for the iOS BGTaskScheduler
 * bridge (CempScheduler/CempSchedulerEngine.{h,m}), proving the ios-prep.md
 * Task 3 mapping against the Android CempSchedulerModule contract:
 *
 *   - periodic → BGAppRefreshTaskRequest under com.cempmobile.sync.tick,
 *     earliestBeginDate from intervalMs, network flag honored
 *   - one-shot → BGProcessingTaskRequest under the shared
 *     com.cempmobile.sync.oneshot, earliestBeginDate from delayMs, network
 *     required (Kotlin constraints)
 *   - KEEP vs UPDATE: replaceExisting=NO submits only when nothing is
 *     pending (single-registration idempotency); replaceExisting=YES
 *     resubmits
 *   - cancel / cancelPeriodic passthrough to the shared identifiers
 *   - completion bookkeeping: a fired task's expiration handler completes
 *     with failure; the JS finish signal completes with success, exactly
 *     once; periodic fire resubmits the next occurrence
 *
 * BGTaskScheduler submission itself is not headlessly testable (needs a
 * registered app); the gateway/handle fakes pin the engine's contract with
 * the real boundary.
 */

#import <XCTest/XCTest.h>
#import <BackgroundTasks/BackgroundTasks.h>

#import "CempSchedulerEngine.h"

#pragma mark - Fakes

@interface FakeGateway : NSObject <CempSchedulerTaskGateway>
@property (nonatomic, strong) NSMutableArray<BGTaskRequest *> *submitted;
@property (nonatomic, strong) NSMutableArray<NSString *> *cancelled;
@property (nonatomic, strong) NSMutableSet<NSString *> *pending;
@end

@implementation FakeGateway
- (instancetype)init {
  self = [super init];
  if (self) {
    _submitted = [NSMutableArray array];
    _cancelled = [NSMutableArray array];
    _pending = [NSMutableSet set];
  }
  return self;
}
- (void)pendingTaskIdentifiers:(void (^)(NSSet<NSString *> *))completion {
  completion([self.pending copy]);
}
- (BOOL)submitTaskRequest:(BGTaskRequest *)request error:(NSError **)error {
  [self.submitted addObject:request];
  // BGTaskScheduler semantics: same identifier replaces the pending request.
  [self.pending addObject:request.identifier];
  return YES;
}
- (void)cancelTaskRequestWithIdentifier:(NSString *)identifier {
  [self.cancelled addObject:identifier];
  [self.pending removeObject:identifier];
}
@end

@interface FakeTaskHandle : NSObject <CempSchedulerTaskHandle>
@property (nonatomic, copy, nullable) void (^expirationHandler)(void);
@property (nonatomic, assign) NSInteger completionCount;
@property (nonatomic, assign) BOOL lastSuccess;
@end

@implementation FakeTaskHandle
- (void)markTaskCompletedWithSuccess:(BOOL)success {
  self.completionCount += 1;
  self.lastSuccess = success;
}
@end

#pragma mark - Tests

@interface CempSchedulerTests : XCTestCase
@end

@implementation CempSchedulerTests {
  FakeGateway *_gateway;
  CempSchedulerEngine *_engine;
}

- (void)setUp {
  [super setUp];
  _gateway = [[FakeGateway alloc] init];
  _engine = [[CempSchedulerEngine alloc] initWithGateway:_gateway];
}

- (void)schedulePeriodic:(double)intervalMs
         requiresNetwork:(BOOL)requiresNetwork
         replaceExisting:(BOOL)replaceExisting {
  XCTestExpectation *done = [self expectationWithDescription:@"scheduled"];
  [_engine schedulePeriodicWithIntervalMs:intervalMs
                          requiresNetwork:requiresNetwork
                          replaceExisting:replaceExisting
                               completion:^(NSError *error) {
    XCTAssertNil(error);
    [done fulfill];
  }];
  [self waitForExpectations:@[done] timeout:5];
}

- (void)testPeriodicRequestConstruction {
  [self schedulePeriodic:900000 requiresNetwork:YES replaceExisting:YES];
  XCTAssertEqual(_gateway.submitted.count, (NSUInteger)1);
  BGTaskRequest *request = _gateway.submitted.firstObject;
  XCTAssertTrue([request isKindOfClass:BGAppRefreshTaskRequest.class]);
  XCTAssertEqualObjects(request.identifier, CempSchedulerPeriodicIdentifier);
  XCTAssertEqualObjects(request.identifier, @"com.cempmobile.sync.tick");
  XCTAssertTrue(request.requiresNetworkConnectivity);
  NSTimeInterval delta =
      [request.earliestBeginDate timeIntervalSinceDate:[NSDate date]];
  XCTAssertTrue(delta > 890 && delta <= 900, @"delta was %f", delta);
}

- (void)testPeriodicNetworkFlagOff {
  [self schedulePeriodic:60000 requiresNetwork:NO replaceExisting:YES];
  BGTaskRequest *request = _gateway.submitted.firstObject;
  XCTAssertFalse(request.requiresNetworkConnectivity);
}

- (void)testKeepIsIdempotentUpdateReplaces {
  // KEEP twice: the second registration defers to the pending tick.
  [self schedulePeriodic:900000 requiresNetwork:YES replaceExisting:NO];
  [self schedulePeriodic:900000 requiresNetwork:YES replaceExisting:NO];
  XCTAssertEqual(_gateway.submitted.count, (NSUInteger)1);

  // UPDATE twice: each replaces the pending request.
  [self schedulePeriodic:900000 requiresNetwork:YES replaceExisting:YES];
  [self schedulePeriodic:900000 requiresNetwork:YES replaceExisting:YES];
  XCTAssertEqual(_gateway.submitted.count, (NSUInteger)3);
}

- (void)testOneShotRequestConstruction {
  XCTestExpectation *done = [self expectationWithDescription:@"scheduled"];
  [_engine scheduleOneShotWithIdentifier:@"route-scan:retry"
                                 delayMs:30000
                              completion:^(NSError *error) {
    XCTAssertNil(error);
    [done fulfill];
  }];
  [self waitForExpectations:@[done] timeout:5];

  XCTAssertEqual(_gateway.submitted.count, (NSUInteger)1);
  BGTaskRequest *request = _gateway.submitted.firstObject;
  XCTAssertTrue([request isKindOfClass:BGProcessingTaskRequest.class]);
  // Any JS id maps to the shared one-shot identifier (documented v1
  // coalescing — the fired tick is generic).
  XCTAssertEqualObjects(request.identifier, CempSchedulerOneShotIdentifier);
  XCTAssertTrue(request.requiresNetworkConnectivity);
  NSTimeInterval delta =
      [request.earliestBeginDate timeIntervalSinceDate:[NSDate date]];
  XCTAssertTrue(delta > 20 && delta <= 30, @"delta was %f", delta);
}

- (void)testCancelPassthrough {
  [_engine cancelWithIdentifier:@"route-scan:retry"];
  XCTAssertEqualObjects(_gateway.cancelled, @[ CempSchedulerOneShotIdentifier ]);
  [_engine cancelPeriodic];
  XCTAssertEqualObjects(_gateway.cancelled,
                        @[ CempSchedulerOneShotIdentifier,
                           CempSchedulerPeriodicIdentifier ]);
}

- (void)testTaskCompletionBookkeeping {
  FakeTaskHandle *handle = [[FakeTaskHandle alloc] init];
  [_engine taskDidFire:handle withIdentifier:CempSchedulerOneShotIdentifier];

  // JS finish signal: completed once, with success.
  [_engine notifyTickFinished];
  XCTAssertEqual(handle.completionCount, (NSInteger)1);
  XCTAssertTrue(handle.lastSuccess);

  // A second signal is a no-op.
  [_engine notifyTickFinished];
  XCTAssertEqual(handle.completionCount, (NSInteger)1);
}

- (void)testExpirationCompletesWithFailure {
  FakeTaskHandle *handle = [[FakeTaskHandle alloc] init];
  [_engine taskDidFire:handle withIdentifier:CempSchedulerOneShotIdentifier];
  XCTAssertNotNil(handle.expirationHandler);
  handle.expirationHandler();
  XCTAssertEqual(handle.completionCount, (NSInteger)1);
  XCTAssertFalse(handle.lastSuccess);

  // A late JS finish signal after expiration is a no-op.
  [_engine notifyTickFinished];
  XCTAssertEqual(handle.completionCount, (NSInteger)1);
}

- (void)testPeriodicFireResubmitsNextOccurrence {
  [self schedulePeriodic:900000 requiresNetwork:YES replaceExisting:YES];
  XCTAssertEqual(_gateway.submitted.count, (NSUInteger)1);

  FakeTaskHandle *handle = [[FakeTaskHandle alloc] init];
  [_engine taskDidFire:handle withIdentifier:CempSchedulerPeriodicIdentifier];

  // iOS refresh tasks are one-shot: the fire resubmits the next occurrence
  // with the same params.
  XCTAssertEqual(_gateway.submitted.count, (NSUInteger)2);
  BGTaskRequest *resubmitted = _gateway.submitted[1];
  XCTAssertTrue([resubmitted isKindOfClass:BGAppRefreshTaskRequest.class]);
  XCTAssertEqualObjects(resubmitted.identifier, CempSchedulerPeriodicIdentifier);
  XCTAssertTrue(resubmitted.requiresNetworkConnectivity);
}

- (void)testTickIdsStartAtOneAndIncrement {
  XCTAssertEqual([_engine nextTickId], (NSInteger)1);
  XCTAssertEqual([_engine nextTickId], (NSInteger)2);
}

@end
