/* See CempImageCodecEngine.h for the behaviour contract. */

#import "CempImageCodecEngine.h"

#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <MobileCoreServices/MobileCoreServices.h>

NSInteger const CempImageCodecMaxDecodeEdgePx = 2560;
NSErrorDomain const CempImageCodecErrorDomain = @"CempImageCodec";

NS_ASSUME_NONNULL_BEGIN

@implementation CempImageCodecResult
- (instancetype)initWithHandle:(NSInteger)handle
                         width:(NSInteger)width
                        height:(NSInteger)height {
  self = [super init];
  if (self) {
    _handle = handle;
    _width = width;
    _height = height;
  }
  return self;
}
@end

static NSInteger CempHexVal(unichar c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static NSError *CempError(CempImageCodecError code, NSString *message) {
  return [NSError errorWithDomain:CempImageCodecErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

@implementation CempImageCodecEngine {
  NSMutableDictionary<NSNumber *, id> *_images; // CF-bridged CGImageRef
  NSLock *_lock;
  NSInteger _nextHandle;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _images = [NSMutableDictionary dictionary];
    _lock = [[NSLock alloc] init];
    _nextHandle = 1;
  }
  return self;
}

+ (nullable NSData *)dataFromHexString:(NSString *)hex {
  NSUInteger n = hex.length;
  if (n % 2 != 0) return nil;
  NSMutableData *data = [NSMutableData dataWithLength:n / 2];
  uint8_t *out = data.mutableBytes;
  for (NSUInteger i = 0; i < n / 2; i++) {
    NSInteger hi = CempHexVal([hex characterAtIndex:2 * i]);
    NSInteger lo = CempHexVal([hex characterAtIndex:2 * i + 1]);
    if (hi < 0 || lo < 0) return nil;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return data;
}

+ (NSString *)hexStringFromData:(NSData *)data {
  static const char digits[] = "0123456789abcdef";
  const uint8_t *bytes = data.bytes;
  NSMutableString *hex = [NSMutableString stringWithCapacity:data.length * 2];
  for (NSUInteger i = 0; i < data.length; i++) {
    [hex appendFormat:@"%c%c", digits[bytes[i] >> 4], digits[bytes[i] & 0xf]];
  }
  return hex;
}

#pragma mark - Registry

/* Store takes ownership of `image` (a +1 CGImageRef). */
- (CempImageCodecResult *)storeImage:(CGImageRef)image {
  [_lock lock];
  NSInteger handle = _nextHandle++;
  _images[@(handle)] = CFBridgingRelease(image);
  [_lock unlock];
  return [[CempImageCodecResult alloc] initWithHandle:handle
                                                width:(NSInteger)CGImageGetWidth(image)
                                               height:(NSInteger)CGImageGetHeight(image)];
}

/* Returns a +1-retained CGImageRef for the handle, or NULL. Caller releases. */
- (nullable CGImageRef)copyImageForHandle:(NSInteger)handle {
  [_lock lock];
  CGImageRef image = (__bridge CGImageRef)_images[@(handle)];
  if (image != NULL) CGImageRetain(image);
  [_lock unlock];
  return image;
}

- (void)releaseHandle:(NSInteger)handle {
  [_lock lock];
  // Removal releases the bridged CGImageRef; unknown handle is a no-op.
  [_images removeObjectForKey:@(handle)];
  [_lock unlock];
}

#pragma mark - Decode

- (nullable CempImageCodecResult *)decodeHex:(NSString *)bytesHex
                                       error:(NSError **)error {
  NSData *data = [CempImageCodecEngine dataFromHexString:bytesHex];
  if (data == nil) {
    if (error) *error = CempError(CempImageCodecErrorDecode,
                                  @"decode: not a decodable image");
    return nil;
  }
  CGImageSourceRef src = CGImageSourceCreateWithData((CFDataRef)data, NULL);
  if (src == NULL) {
    if (error) *error = CempError(CempImageCodecErrorDecode,
                                  @"decode: not a decodable image");
    return nil;
  }

  // Pass 1: bounds only — validates decodability without decoding pixels.
  NSDictionary *props = CFBridgingRelease(
      CGImageSourceCopyPropertiesAtIndex(src, 0, NULL));
  NSNumber *srcW = props[(id)kCGImagePropertyPixelWidth];
  NSNumber *srcH = props[(id)kCGImagePropertyPixelHeight];
  if (srcW.integerValue <= 0 || srcH.integerValue <= 0) {
    CFRelease(src);
    if (error) *error = CempError(CempImageCodecErrorDecode,
                                  @"decode: not a decodable image");
    return nil;
  }

  // Pass 2: sampled thumbnail — caps the longest edge (OOM guard) and bakes
  // EXIF orientation into the pixels. No metadata survives into the CGImage.
  NSDictionary *options = @{
    (id)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
    (id)kCGImageSourceCreateThumbnailWithTransform : @YES,
    (id)kCGImageSourceThumbnailMaxPixelSize : @(CempImageCodecMaxDecodeEdgePx),
    (id)kCGImageSourceShouldCache : @NO,
  };
  CGImageRef image =
      CGImageSourceCreateThumbnailAtIndex(src, 0, (CFDictionaryRef)options);
  CFRelease(src);
  if (image == NULL) {
    if (error) *error = CempError(CempImageCodecErrorDecode,
                                  @"decode: not a decodable image");
    return nil;
  }
  return [self storeImage:image];
}

#pragma mark - Resize

/* Render `image` into a fresh RGBA8888 bitmap context at exact dims. */
- (nullable CGImageRef)renderImage:(CGImageRef)image
                             width:(NSInteger)width
                            height:(NSInteger)height
                       opaqueBuffer:(BOOL)opaque {
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGBitmapInfo bitmapInfo =
      opaque ? (kCGImageAlphaNoneSkipLast | kCGBitmapByteOrderDefault)
             : (kCGImageAlphaPremultipliedLast | kCGBitmapByteOrderDefault);
  CGContextRef context = CGBitmapContextCreate(
      NULL, (size_t)width, (size_t)height, 8, 0, colorSpace, bitmapInfo);
  CGColorSpaceRelease(colorSpace);
  if (context == NULL) return NULL;
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
  CGImageRef out = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  return out;
}

- (nullable CempImageCodecResult *)resizeHandle:(NSInteger)handle
                                          width:(NSInteger)width
                                         height:(NSInteger)height
                                          error:(NSError **)error {
  CGImageRef src = [self copyImageForHandle:handle];
  if (src == NULL) {
    if (error) *error = CempError(CempImageCodecErrorUnknownHandle,
                                  @"resize: unknown handle");
    return nil;
  }
  if (width <= 0 || height <= 0) {
    CGImageRelease(src);
    if (error) *error = CempError(CempImageCodecErrorBadParams,
                                  @"resize: bad dimensions");
    return nil;
  }
  // Always a fresh buffer, even when dims match the source: each handle owns
  // distinct pixels, so release can never cause use-after-free (the Android
  // module's defensive-copy rule).
  CGImageRef out = [self renderImage:src width:width height:height opaqueBuffer:NO];
  CGImageRelease(src);
  if (out == NULL) {
    if (error) *error = CempError(CempImageCodecErrorResize,
                                  @"resize: could not resize image");
    return nil;
  }
  return [self storeImage:out];
}

#pragma mark - Encode

- (nullable NSString *)encodeHandle:(NSInteger)handle
                             format:(NSString *)format
                            quality:(NSInteger)quality
                              error:(NSError **)error {
  CGImageRef image = [self copyImageForHandle:handle];
  if (image == NULL) {
    if (error) *error = CempError(CempImageCodecErrorUnknownHandle,
                                  @"encode: unknown handle");
    return nil;
  }

  CFStringRef uti;
  BOOL isWebP = NO;
  if ([format isEqualToString:@"jpeg"]) {
    uti = kUTTypeJPEG;
  } else if ([format isEqualToString:@"webp"]) {
    uti = (__bridge CFStringRef) @"public.webp"; // kUTTypeWebP, iOS 14+
    isWebP = YES;
  } else {
    CGImageRelease(image);
    if (error) *error = CempError(CempImageCodecErrorUnsupportedFormat,
                                  @"encode: unsupported format");
    return nil;
  }

  // JPEG has no alpha channel: flatten onto an opaque buffer (Android's
  // Bitmap.compress(JPEG) likewise drops alpha).
  CGImageRef toEncode = image;
  CGImageRef flattened = NULL;
  if (!isWebP && CGImageGetAlphaInfo(image) != kCGImageAlphaNone) {
    flattened = [self renderImage:image
                            width:(NSInteger)CGImageGetWidth(image)
                           height:(NSInteger)CGImageGetHeight(image)
                      opaqueBuffer:YES];
    if (flattened != NULL) toEncode = flattened;
  }

  CGFloat q = (CGFloat)MAX(0, MIN(100, quality)) / 100.0;
  NSMutableData *out = [NSMutableData data];
  CGImageDestinationRef dest =
      CGImageDestinationCreateWithData((CFMutableDataRef)out, uti, 1, NULL);
  BOOL ok = NO;
  if (dest != NULL) {
    CGImageDestinationAddImage(
        dest, toEncode,
        (CFDictionaryRef) @{
          (id)kCGImageDestinationLossyCompressionQuality : @(q)
        });
    ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
  }
  if (flattened != NULL) CGImageRelease(flattened);
  CGImageRelease(image);

  if (!ok) {
    if (error) {
      *error = isWebP
          ? CempError(CempImageCodecErrorWebPUnsupported,
                      @"encode: webp not supported by this ImageIO")
          : CempError(CempImageCodecErrorEncode,
                      @"encode: could not encode image");
    }
    return nil;
  }
  return [CempImageCodecEngine hexStringFromData:out];
}

@end

NS_ASSUME_NONNULL_END
