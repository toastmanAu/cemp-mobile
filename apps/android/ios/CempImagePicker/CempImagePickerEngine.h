/*
 * CempImagePickerEngine — the React-free core of the CempImagePicker native
 * module (apps/android/ios/CempImagePicker/CempImagePicker.m), mirroring the
 * Android CempImagePickerModule (android/app/src/main/java/com/cempmobile/
 * imaging) behaviour contract:
 *
 *   - ATOMIC PENDING-PROMISE: a single pick is in flight at any time;
 *     beginning a new pick REJECTS the previous one (superseded — the
 *     Kotlin getAndSet semantics). A late result with no pending pick is
 *     dropped, never misdelivered.
 *   - 64 MB byte cap on the result read, enforced DURING a streaming read
 *     (an unbounded read of a huge/hostile stream OOMs the app).
 *   - Cancel resolves with no bytes and no error (JS maps that to null).
 *   - invalidate rejects any pending pick (bridge teardown — a hung promise
 *     freezes the send flow permanently); a later pick works again.
 *   - Result bytes are the ORIGINAL representation the itemProvider offers
 *     (public.jpeg / public.png / public.webp preferred) — never re-encoded;
 *     the codec pipeline owns re-encoding and EXIF strip downstream.
 *   - Rule 2: error messages are static strings only, never payload data.
 *
 * This class is deliberately free of any React Native import (and does not
 * present UI) so the XCTest target can drive it headlessly with real
 * NSItemProvider instances — same two-layer pattern as CempKdfCore and
 * CempImageCodecEngine.
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/** Hard cap on the picked image size (64 MiB — the Android review finding). */
extern NSInteger const CempImagePickerMaxPickBytes;

/** Error domain; codes below. Messages are static strings (rule 2). */
extern NSErrorDomain const CempImagePickerErrorDomain;

typedef NS_ERROR_ENUM(CempImagePickerErrorDomain, CempImagePickerError) {
  /** A second pick superseded this one. */
  CempImagePickerErrorSuperseded = 1,
  /** Bridge teardown (invalidate) before a result arrived. */
  CempImagePickerErrorInvalidated = 2,
  /** The picker UI could not be launched. */
  CempImagePickerErrorLaunch = 3,
  /** The selected image could not be read. */
  CempImagePickerErrorRead = 4,
  /** The selected image exceeds CempImagePickerMaxPickBytes. */
  CempImagePickerErrorTooLarge = 5,
};

/**
 * Settles a pick: hex != nil resolves the image bytes (lowercase hex);
 * hex == nil && error == nil resolves cancel (JS null); error != nil rejects.
 */
typedef void (^CempImagePickerCompletion)(NSString *_Nullable hex,
                                          NSError *_Nullable error);

@interface CempImagePickerEngine : NSObject

/**
 * Install the completion for the one in-flight pick, atomically. Any prior
 * in-flight pick is rejected with CempImagePickerErrorSuperseded.
 */
- (void)beginPickWithCompletion:(CempImagePickerCompletion)completion;

/**
 * The picker UI could not be presented: rejects the pending pick with
 * CempImagePickerErrorLaunch (no-op when nothing is pending).
 */
- (void)failLaunch;

/**
 * Process a PHPicker result. nil/empty providers = user cancel → resolve
 * with no bytes. Otherwise the first provider's data is loaded (original
 * representation, streamed under the 64 MB cap) and the pending pick
 * settles. A result arriving with no pending pick is dropped.
 */
- (void)processPickerResults:(nullable NSArray<NSItemProvider *> *)providers;

/**
 * Bridge teardown: reject any pending pick with
 * CempImagePickerErrorInvalidated. The engine remains usable — a later
 * beginPickWithCompletion: works normally.
 */
- (void)invalidate;

@end

NS_ASSUME_NONNULL_END
