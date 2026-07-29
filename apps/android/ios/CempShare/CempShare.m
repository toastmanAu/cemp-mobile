/*
 * CempShare — share sheet bridge, the iOS counterpart of the Android
 * CempShare Kotlin module. JS surface (apps/android/src/platform/native-share.ts):
 *
 *   NativeModules.CempShare.shareImage(pngHex, caption) -> Promise<void>
 *
 * Legacy RCTBridgeModule on purpose, matching the other four modules: RN
 * 0.83's bridgeless interop layer picks it up unchanged.
 */

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>

@interface CempShare : NSObject <RCTBridgeModule>
@end

@implementation CempShare

RCT_EXPORT_MODULE(CempShare);

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

RCT_EXPORT_METHOD(shareImage:(NSString *)pngHex
                     caption:(NSString *)caption
                    resolver:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject)
{
  NSData *png = DataFromHex(pngHex);
  if (png == nil) {
    reject(@"share-error", @"image payload was not valid hex", nil);
    return;
  }
  NSURL *url = [[NSURL fileURLWithPath:NSTemporaryDirectory()]
      URLByAppendingPathComponent:@"cellsend-contact.png"];
  NSError *writeError = nil;
  if (![png writeToURL:url options:NSDataWritingAtomic error:&writeError]) {
    reject(@"share-error", @"could not write the card image", writeError);
    return;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    UIActivityViewController *sheet =
        [[UIActivityViewController alloc] initWithActivityItems:@[ url, caption ]
                                         applicationActivities:nil];
    UIViewController *presenter = RCTPresentedViewController();
    if (presenter == nil) {
      reject(@"share-error", @"no view controller to present from", nil);
      return;
    }
    // iPad requires a popover anchor or this throws.
    sheet.popoverPresentationController.sourceView = presenter.view;
    sheet.popoverPresentationController.sourceRect =
        CGRectMake(CGRectGetMidX(presenter.view.bounds),
                   CGRectGetMidY(presenter.view.bounds), 0, 0);
    [presenter presentViewController:sheet animated:YES completion:^{
      resolve(nil);
    }];
  });
}

@end
