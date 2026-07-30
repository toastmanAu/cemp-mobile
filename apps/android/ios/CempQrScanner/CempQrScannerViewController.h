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
 * Fires exactly once, on every path: a decoded QR string, or nil for
 * cancel — the Cancel button, a dismissed sheet, or no usable camera
 * (simulator, hardware fault, denied permission). Cleared once fired.
 */
@property (nonatomic, copy, nullable) void (^onResult)(NSString *_Nullable text);

@end

NS_ASSUME_NONNULL_END
