/*
 * CempSchedulerEngine — the React-free core of the CempScheduler native
 * module (apps/android/ios/CempScheduler/CempScheduler.m), the iOS
 * BGTaskScheduler implementation of the @cemp/sync `Scheduler` seam
 * (ios-prep.md Task 3), mirroring the Android CempSchedulerModule
 * (WorkManager) contract.
 *
 * Mapping (Task 3 decisions):
 *   - schedulePeriodic → BGAppRefreshTaskRequest. iOS has NO true periodic
 *     background work: each refresh task is one-shot and the OS decides the
 *     cadence (best-effort accelerator — FOREGROUND CATCH-UP owns
 *     correctness). The engine emulates periodicity by resubmitting the
 *     next occurrence each time the periodic task fires.
 *   - scheduleOneShot → BGProcessingTaskRequest (network required, like the
 *     Kotlin constraints).
 *   - cancel/cancelPeriodic → BGTaskScheduler cancel.
 *
 * Identifiers (registered in Info.plist BGTaskSchedulerPermittedIdentifiers;
 * wildcards are not relied upon):
 *   - periodic: CempSchedulerPeriodicIdentifier (the TS side coalesces every
 *     worker into ONE tick — Phase 9 design D4)
 *   - one-shot: CempSchedulerOneShotIdentifier, SHARED by all retry
 *     one-shots (resubmission replaces). Safe because the JS tick is
 *     generic — a fired tick always runs the same full sync / locked probe,
 *     never per-worker work — so coalescing two pending retries only merges
 *     their timing, never drops semantics. Documented v1 deviation from
 *     Android's per-id unique work.
 *
 * KEEP vs UPDATE: BGTaskScheduler has no KEEP — submitting with an existing
 * identifier REPLACES. replaceExisting=NO therefore queries the pending
 * requests first and submits only when absent (WorkManager KEEP);
 * replaceExisting=YES submits unconditionally (WorkManager UPDATE). The
 * Kotlin SCHEDULE_VERSION upgrade guard is WorkManager-specific (the period
 * is baked into a persisted WorkSpec); on iOS every fire and every unlock
 * re-registers, so no equivalent is persisted (documented deviation).
 *
 * This class is deliberately free of any React Native import so the XCTest
 * target can drive it headlessly with a fake gateway and fake task handles
 * (same two-layer pattern as CempKdfCore / CempImageCodecEngine).
 */

#import <BackgroundTasks/BackgroundTasks.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/** BGTask identifiers — must match Info.plist BGTaskSchedulerPermittedIdentifiers. */
extern NSString *const CempSchedulerPeriodicIdentifier; // com.cempmobile.sync.tick
extern NSString *const CempSchedulerOneShotIdentifier;  // com.cempmobile.sync.oneshot

/**
 * The system boundary. The bridge implements this over BGTaskScheduler;
 * tests substitute a fake. Kept minimal so the engine is fully headless.
 */
@protocol CempSchedulerTaskGateway <NSObject>
- (void)pendingTaskIdentifiers:(void (^)(NSSet<NSString *> *identifiers))completion;
- (BOOL)submitTaskRequest:(BGTaskRequest *)request error:(NSError **)error;
- (void)cancelTaskRequestWithIdentifier:(NSString *)identifier;
@end

/**
 * A fired background task under completion bookkeeping. The bridge adapts a
 * real BGTask; tests use a fake. `expirationHandler` mirrors BGTask's.
 */
@protocol CempSchedulerTaskHandle <NSObject>
@property (nonatomic, copy, nullable) void (^expirationHandler)(void);
- (void)markTaskCompletedWithSuccess:(BOOL)success;
@end

@interface CempSchedulerEngine : NSObject

- (instancetype)initWithGateway:(id<CempSchedulerTaskGateway>)gateway;

/** WorkManager KEEP/UPDATE semantics — see the class doc. */
- (void)schedulePeriodicWithIntervalMs:(double)intervalMs
                       requiresNetwork:(BOOL)requiresNetwork
                       replaceExisting:(BOOL)replaceExisting
                            completion:(void (^)(NSError *_Nullable error))completion;

/** `identifier` is the JS worker/retry id; it maps to the shared one-shot. */
- (void)scheduleOneShotWithIdentifier:(NSString *)identifier
                              delayMs:(double)delayMs
                           completion:(void (^)(NSError *_Nullable error))completion;

/** Cancels the shared one-shot (the only id-addressable request on iOS). */
- (void)cancelWithIdentifier:(NSString *)identifier;

/** Cancels the coalesced periodic tick (factory wipe path). */
- (void)cancelPeriodic;

/** Process-local tick correlation ids for the JS payload (start at 1). */
- (NSInteger)nextTickId;

/**
 * A BGTask fired: wires the expiration handler (completes with failure) and
 * starts completion bookkeeping; when it is the periodic task, resubmits
 * the next occurrence from the last scheduled params (iOS "periodicity").
 */
- (void)taskDidFire:(id<CempSchedulerTaskHandle>)handle
     withIdentifier:(NSString *)identifier;

/**
 * The JS tick signalled completion (via the CempHeadlessTask module):
 * complete every task under bookkeeping with success, exactly once each.
 * A second signal is a no-op.
 */
- (void)notifyTickFinished;

@end

NS_ASSUME_NONNULL_END
