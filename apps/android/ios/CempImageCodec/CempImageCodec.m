/*
 * CempImageCodec — React Native bridge module for the image codec, the iOS
 * counterpart of the Android CempImageCodecModule (android/app/src/main/
 * java/com/cempmobile/imaging). The JS-facing surface is identical
 * (apps/android/src/platform/native-image-codec.ts):
 *
 *   NativeModules.CempImageCodec.decode(bytesHex)
 *     -> Promise<{handle, width, height}>
 *   NativeModules.CempImageCodec.resize(handle, width, height)
 *     -> Promise<{handle, width, height}>
 *   NativeModules.CempImageCodec.encode(handle, format, quality)
 *     -> Promise<hex bytes>          // format: "jpeg" | "webp"
 *   NativeModules.CempImageCodec.release(handle)
 *     -> Promise<void>               // double release is a no-op
 *
 * `DecodedImage.pixels` on the JS side carries the opaque Int handle; JS
 * never sees raw pixels. All behaviour (sampled decode, orientation baking,
 * strip-by-construction, handle lifecycle) lives in CempImageCodecEngine and
 * is XCTest-proven in CempMobileTests/CempImageCodecTests.m. Never log
 * payload data (AGENTS.md rule 2) — errors carry static strings only.
 */

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#import "CempImageCodecEngine.h"

@interface CempImageCodec : NSObject <RCTBridgeModule>
@end

@implementation CempImageCodec {
  CempImageCodecEngine *_engine;
}

RCT_EXPORT_MODULE(CempImageCodec);

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _engine = [[CempImageCodecEngine alloc] init];
  }
  return self;
}

static NSDictionary *ResultMap(CempImageCodecResult *result)
{
  return @{
    @"handle" : @(result.handle),
    @"width" : @(result.width),
    @"height" : @(result.height),
  };
}

RCT_EXPORT_METHOD(decode:(NSString *)bytesHex
                resolver:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    CempImageCodecResult *result = [_engine decodeHex:bytesHex error:&error];
    if (result != nil) {
      resolve(ResultMap(result));
    } else {
      reject(@"image-decode-error", @"could not decode image", error);
    }
  });
}

RCT_EXPORT_METHOD(resize:(nonnull NSNumber *)handle
                  width:(nonnull NSNumber *)width
                 height:(nonnull NSNumber *)height
               resolver:(RCTPromiseResolveBlock)resolve
               rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    CempImageCodecResult *result =
        [_engine resizeHandle:handle.integerValue
                        width:width.integerValue
                       height:height.integerValue
                        error:&error];
    if (result != nil) {
      resolve(ResultMap(result));
    } else {
      reject(@"image-resize-error", @"could not resize image", error);
    }
  });
}

RCT_EXPORT_METHOD(encode:(nonnull NSNumber *)handle
                 format:(NSString *)format
                quality:(nonnull NSNumber *)quality
               resolver:(RCTPromiseResolveBlock)resolve
               rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    NSString *hex = [_engine encodeHandle:handle.integerValue
                                   format:format
                                  quality:quality.integerValue
                                    error:&error];
    if (hex != nil) {
      resolve(hex);
    } else {
      reject(@"image-encode-error", @"could not encode image", error);
    }
  });
}

RCT_EXPORT_METHOD(release:(nonnull NSNumber *)handle
                resolver:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject)
{
  // Deliberately synchronous (like the Kotlin side): releasing a CGImage is
  // cheap, unlike decode/resize/encode which do real pixel work.
  [_engine releaseHandle:handle.integerValue];
  resolve(nil);
}

@end
