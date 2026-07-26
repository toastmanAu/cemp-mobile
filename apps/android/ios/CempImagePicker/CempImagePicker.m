/*
 * CempImagePicker — React Native bridge module for the system photo picker,
 * the iOS counterpart of the Android CempImagePickerModule. The JS-facing
 * surface is identical (apps/android/src/platform/native-image-picker.ts):
 *
 *   NativeModules.CempImagePicker.pick()
 *     -> Promise<string | null>   // lowercase hex bytes, or null on cancel
 *
 * Thin shell: PHPickerViewController presentation (system picker, images
 * only, NO photo-library permission needed) + the React promise plumbing.
 * All behaviour (single in-flight pick with supersede semantics, 64 MB cap,
 * byte handling, invalidate) lives in CempImagePickerEngine and is
 * XCTest-proven in CempMobileTests/CempImagePickerTests.m. Never log
 * payload data (AGENTS.md rule 2) — errors carry static strings only.
 */

#import <Foundation/Foundation.h>
#import <PhotosUI/PHPicker.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

#import "CempImagePickerEngine.h"

@interface CempImagePicker : NSObject <RCTBridgeModule, PHPickerViewControllerDelegate>
@end

@implementation CempImagePicker {
  CempImagePickerEngine *_engine;
}

RCT_EXPORT_MODULE(CempImagePicker);

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _engine = [[CempImagePickerEngine alloc] init];
  }
  return self;
}

/* Map the engine error codes onto the Kotlin module's reject codes. */
static NSString *BridgeCode(NSError *error)
{
  switch ((CempImagePickerError)error.code) {
    case CempImagePickerErrorSuperseded:
    case CempImagePickerErrorInvalidated:
      return @"image-pick-cancelled";
    case CempImagePickerErrorLaunch:
      return @"image-pick-error";
    case CempImagePickerErrorRead:
    case CempImagePickerErrorTooLarge:
      return @"image-pick-read-error";
  }
}

RCT_EXPORT_METHOD(pick:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject)
{
  [_engine beginPickWithCompletion:^(NSString *hex, NSError *error) {
    if (error != nil) {
      reject(BridgeCode(error), error.localizedDescription, error);
    } else {
      resolve(hex); // nil hex = user cancel -> JS null
    }
  }];
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = [CempImagePicker topViewController];
    if (presenter == nil) {
      [_engine failLaunch];
      return;
    }
    PHPickerConfiguration *config =
        [[PHPickerConfiguration alloc] init];
    config.selectionLimit = 1;
    config.filter = [PHPickerFilter imagesFilter]; // images only, no video
    PHPickerViewController *picker =
        [[PHPickerViewController alloc] initWithConfiguration:config];
    picker.delegate = self;
    [presenter presentViewController:picker animated:YES completion:nil];
  });
}

/* The app delegate owns the window in the RN 0.83 factory template. */
+ (nullable UIViewController *)topViewController
{
  UIWindow *window = UIApplication.sharedApplication.delegate.window;
  UIViewController *vc = window.rootViewController;
  while (vc.presentedViewController != nil) {
    vc = vc.presentedViewController;
  }
  return vc;
}

- (void)picker:(PHPickerViewController *)picker
    didFinishPicking:(NSArray<PHPickerResult *> *)results
{
  [picker dismissViewControllerAnimated:YES completion:nil];
  NSMutableArray<NSItemProvider *> *providers =
      [NSMutableArray arrayWithCapacity:results.count];
  for (PHPickerResult *result in results) {
    [providers addObject:result.itemProvider];
  }
  // Empty results = user cancel; the engine resolves nil.
  [_engine processPickerResults:providers];
}

/* Bridge teardown (RN 0.83 hook; matches the Kotlin invalidate fix): reject
 * any pending pick so the JS promise settles instead of hanging forever. */
- (void)invalidate
{
  [_engine invalidate];
}

@end
