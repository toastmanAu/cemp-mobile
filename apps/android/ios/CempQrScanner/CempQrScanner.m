/*
 * CempQrScanner — QR decode bridge, the iOS counterpart of the Android
 * CempQrScanner Kotlin module. JS surface
 * (apps/android/src/platform/native-qr-scanner.ts):
 *
 *   NativeModules.CempQrScanner.scanImage(bytesHex) -> Promise<string | null>
 *   NativeModules.CempQrScanner.scanWithCamera()     -> Promise<string | null>
 *
 * null covers both "no code in the image" and "user cancelled the camera
 * (including a denied permission)" — those are normal outcomes, not errors.
 * A genuinely undecodable input (bad hex, unreadable image bytes) rejects.
 * Never log decoded payloads (AGENTS.md rule 2) — only static strings appear
 * in reject messages.
 */

#import <CoreImage/CoreImage.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>

#import "CempQrScannerViewController.h"

@interface CempQrScanner : NSObject <RCTBridgeModule>
@end

@implementation CempQrScanner

RCT_EXPORT_MODULE(CempQrScanner);

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

static NSData *DataFromHex(NSString *hex)
{
  NSUInteger length = hex.length / 2;
  NSMutableData *data = [NSMutableData dataWithCapacity:length];
  const char *chars = hex.UTF8String;
  for (NSUInteger i = 0; i < length; i++) {
    char byte[3] = {chars[i * 2], chars[i * 2 + 1], '\0'};
    unsigned int value = 0;
    if (sscanf(byte, "%x", &value) != 1) {
      return nil;
    }
    uint8_t b = (uint8_t)value;
    [data appendBytes:&b length:1];
  }
  return data;
}

RCT_EXPORT_METHOD(scanImage:(NSString *)bytesHex
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *data = DataFromHex(bytesHex);
  if (data == nil) {
    reject(@"qr-decode-error", @"image payload was not valid hex", nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    CIImage *image = [CIImage imageWithData:data];
    if (image == nil) {
      reject(@"qr-decode-error", @"could not read that image", nil);
      return;
    }
    VNDetectBarcodesRequest *request = [[VNDetectBarcodesRequest alloc] init];
    request.symbologies = @[ VNBarcodeSymbologyQR ];
    VNImageRequestHandler *handler =
        [[VNImageRequestHandler alloc] initWithCIImage:image options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[ request ] error:&error]) {
      reject(@"qr-decode-error", @"could not scan that image", error);
      return;
    }
    for (VNBarcodeObservation *obs in request.results) {
      if (obs.payloadStringValue.length > 0) {
        resolve(obs.payloadStringValue);
        return;
      }
    }
    // No code found is a normal outcome, not an error.
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(scanWithCamera:(RCTPromiseResolveBlock)resolve
                        rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = RCTPresentedViewController();
    if (presenter == nil) {
      reject(@"qr-scan-error", @"no view controller to present from", nil);
      return;
    }
    CempQrScannerViewController *vc = [[CempQrScannerViewController alloc] init];
    vc.onResult = ^(NSString *_Nullable text) {
      [presenter dismissViewControllerAnimated:YES completion:^{
        resolve(text);
      }];
    };
    [presenter presentViewController:vc animated:YES completion:nil];
  });
}

@end
