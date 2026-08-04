/*
 * CempQrScannerViewController — full-screen AVFoundation QR camera scanner,
 * presented by CempQrScanner.m's scanWithCamera(). See that file for the
 * JS-facing promise contract.
 */

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface CempQrScannerViewController : UIViewController

/**
 * Fires exactly once, on every non-permission-denied path: a decoded QR
 * string, or nil for cancel — the Cancel button or no usable camera
 * (simulator, hardware fault). The view controller is presented
 * `UIModalPresentationFullScreen`, so there is no interactive swipe-to-
 * dismiss gesture; `viewDidDisappear:` still calls this with nil as a
 * belt-and-braces settle for any dismissal this class didn't itself
 * initiate. Cleared once fired. Exactly one of `onResult` /
 * `onPermissionDenied` ever fires.
 */
@property (nonatomic, copy, nullable) void (^onResult)(NSString *_Nullable text);

/**
 * Fires exactly once instead of `onResult` when the camera permission is
 * denied or restricted (checked before any `AVCaptureSession` is built).
 * Distinguishing this from a plain cancel lets the JS seam surface an
 * honest, permission-naming message instead of silently doing nothing.
 * Cleared once fired.
 */
@property (nonatomic, copy, nullable) void (^onPermissionDenied)(void);

@end

NS_ASSUME_NONNULL_END
