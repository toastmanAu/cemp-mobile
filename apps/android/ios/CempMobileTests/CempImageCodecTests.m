/*
 * CempImageCodecTests — conformance tests for the iOS image codec engine
 * (CempImageCodec/CempImageCodecEngine.{h,m}), proving the ios-prep.md Task
 * 5 hard requirements against the same contract the Android
 * CempImageCodecModule implements (T17):
 *
 *   - EXIF orientation baked into pixels at decode (orientation-6 JPEG)
 *   - two-pass sampled decode caps the longest edge at 2560 px (OOM guard)
 *   - resize produces exact dims and alias-safe handles
 *   - JPEG encode sniffs JFIF and honors quality
 *   - WebP encode: supported by ImageIO, or the documented fallback error
 *   - handle lifecycle: unknown/double release is a no-op, use-after-release
 *     fails cleanly
 *
 * Errors must carry static strings only (rule 2) — these tests also pin the
 * error codes the JS fallback policy depends on.
 */

#import <XCTest/XCTest.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <MobileCoreServices/MobileCoreServices.h>

#import "CempImageCodecEngine.h"

@interface CempImageCodecTests : XCTestCase
@end

@implementation CempImageCodecTests {
  CempImageCodecEngine *_engine;
}

- (void)setUp {
  [super setUp];
  _engine = [[CempImageCodecEngine alloc] init];
}

#pragma mark - Synthetic image helpers

/* xorshift32-filled RGBA image (incompressible — exercises quality scaling). */
- (CGImageRef)makeNoisyImageWidth:(NSInteger)w height:(NSInteger)h {
  size_t bytes = (size_t)w * (size_t)h * 4;
  uint8_t *buf = malloc(bytes);
  uint32_t state = 0x9e3779b9u;
  for (size_t i = 0; i < bytes; i += 4) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    buf[i] = (uint8_t)state;
    buf[i + 1] = (uint8_t)(state >> 8);
    buf[i + 2] = (uint8_t)(state >> 16);
    buf[i + 3] = 0xff;
  }
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(
      buf, (size_t)w, (size_t)h, 8, (size_t)w * 4, cs,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrderDefault);
  CGColorSpaceRelease(cs);
  CGImageRef image = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  free(buf);
  return image;
}

/* Solid-color RGBA image (compresses tiny — used for the big-dims case). */
- (CGImageRef)makeSolidImageWidth:(NSInteger)w height:(NSInteger)h {
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(
      NULL, (size_t)w, (size_t)h, 8, 0, cs,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrderDefault);
  CGColorSpaceRelease(cs);
  CGContextSetRGBFillColor(ctx, 0.2, 0.4, 0.6, 1.0);
  CGContextFillRect(ctx, CGRectMake(0, 0, w, h));
  CGImageRef image = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  return image;
}

/* Encode a CGImage to NSData; orientation (0 = none) written as metadata. */
- (NSData *)encodeImage:(CGImageRef)image
                    uti:(CFStringRef)uti
            orientation:(int)orientation {
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dest =
      CGImageDestinationCreateWithData((CFMutableDataRef)data, uti, 1, NULL);
  XCTAssertTrue(dest != NULL);
  NSDictionary *props = orientation == 0
      ? @{}
      : @{(id)kCGImagePropertyOrientation : @(orientation)};
  CGImageDestinationAddImage(dest, image, (CFDictionaryRef)props);
  XCTAssertTrue(CGImageDestinationFinalize(dest));
  CFRelease(dest);
  return data;
}

- (CempImageCodecResult *)decodeData:(NSData *)data {
  NSError *error = nil;
  CempImageCodecResult *result =
      [_engine decodeHex:[CempImageCodecEngine hexStringFromData:data]
                   error:&error];
  XCTAssertNotNil(result, @"decode failed: %@", error.localizedDescription);
  return result;
}

- (NSData *)encodeHandle:(NSInteger)handle
                  format:(NSString *)format
                 quality:(NSInteger)quality {
  NSError *error = nil;
  NSString *hex = [_engine encodeHandle:handle
                                 format:format
                                quality:quality
                                  error:&error];
  XCTAssertNotNil(hex, @"encode failed: %@", error.localizedDescription);
  return [CempImageCodecEngine dataFromHexString:hex];
}

#pragma mark - Tests

- (void)testDecodeBakesExifOrientation {
  CGImageRef img = [self makeSolidImageWidth:40 height:20];
  NSData *jpeg = [self encodeImage:img uti:kUTTypeJPEG orientation:6];
  CGImageRelease(img);

  CempImageCodecResult *r = [self decodeData:jpeg];
  // Orientation 6 = rotate 90° CW: width/height swap.
  XCTAssertEqual(r.width, (NSInteger)20);
  XCTAssertEqual(r.height, (NSInteger)40);
  [_engine releaseHandle:r.handle];
}

- (void)testSampledDecodeCapsLongestEdge {
  CGImageRef img = [self makeSolidImageWidth:6000 height:4000];
  NSData *png = [self encodeImage:img uti:kUTTypePNG orientation:0];
  CGImageRelease(img);

  CempImageCodecResult *r = [self decodeData:png];
  NSInteger longest = MAX(r.width, r.height);
  XCTAssertEqual(longest, CempImageCodecMaxDecodeEdgePx);
  // Aspect preserved (6000x4000 scaled by 2560/6000 = 1706.67).
  XCTAssertTrue(llabs(r.height - 1707) <= 2, @"height was %ld", (long)r.height);
  [_engine releaseHandle:r.handle];
}

- (void)testResizeExactDimsAndAliasSafety {
  CGImageRef img = [self makeSolidImageWidth:100 height:50];
  NSData *png = [self encodeImage:img uti:kUTTypePNG orientation:0];
  CGImageRelease(img);

  CempImageCodecResult *r1 = [self decodeData:png];
  NSError *error = nil;
  CempImageCodecResult *r2 =
      [_engine resizeHandle:r1.handle width:30 height:30 error:&error];
  XCTAssertNotNil(r2);
  XCTAssertEqual(r2.width, (NSInteger)30);
  XCTAssertEqual(r2.height, (NSInteger)30);

  // Same-dims resize (the aliasing case): distinct, independently-owned
  // handle — releasing one must not invalidate the other.
  CempImageCodecResult *r3 =
      [_engine resizeHandle:r2.handle width:30 height:30 error:&error];
  XCTAssertNotNil(r3);
  XCTAssertNotEqual(r3.handle, r2.handle);
  [_engine releaseHandle:r2.handle];
  NSData *jpeg = [self encodeHandle:r3.handle format:@"jpeg" quality:80];
  XCTAssertTrue(jpeg.length > 0);

  [_engine releaseHandle:r1.handle];
  [_engine releaseHandle:r3.handle];
}

- (void)testEncodeJpegSniffAndQuality {
  CGImageRef img = [self makeNoisyImageWidth:512 height:512];
  NSData *png = [self encodeImage:img uti:kUTTypePNG orientation:0];
  CGImageRelease(img);

  CempImageCodecResult *r = [self decodeData:png];
  NSData *q90 = [self encodeHandle:r.handle format:@"jpeg" quality:90];
  NSData *q10 = [self encodeHandle:r.handle format:@"jpeg" quality:10];

  // JFIF/EXIF sniff: FF D8 FF.
  const uint8_t *magic = q90.bytes;
  XCTAssertTrue(q90.length > 3);
  XCTAssertEqual(magic[0], (uint8_t)0xFF);
  XCTAssertEqual(magic[1], (uint8_t)0xD8);
  XCTAssertEqual(magic[2], (uint8_t)0xFF);
  // Quality honored on a noisy image: lower quality = fewer bytes.
  XCTAssertTrue(q10.length < q90.length,
                @"q10=%lu q90=%lu", (unsigned long)q10.length,
                (unsigned long)q90.length);
  [_engine releaseHandle:r.handle];
}

- (void)testEncodeWebPSupportedOrDocumentedFallback {
  CGImageRef img = [self makeNoisyImageWidth:256 height:256];
  NSData *png = [self encodeImage:img uti:kUTTypePNG orientation:0];
  CGImageRelease(img);

  CempImageCodecResult *r = [self decodeData:png];
  NSError *error = nil;
  NSString *hex = [_engine encodeHandle:r.handle
                                 format:@"webp"
                                quality:80
                                  error:&error];
  if (hex != nil) {
    NSLog(@"WEBP-ENCODE: supported");
    NSData *webp = [CempImageCodecEngine dataFromHexString:hex];
    // RIFF....WEBP sniff.
    const uint8_t *b = webp.bytes;
    XCTAssertTrue(webp.length > 12);
    XCTAssertEqual(b[0], (uint8_t)'R');
    XCTAssertEqual(b[1], (uint8_t)'I');
    XCTAssertEqual(b[2], (uint8_t)'F');
    XCTAssertEqual(b[3], (uint8_t)'F');
    XCTAssertEqual(b[8], (uint8_t)'W');
    XCTAssertEqual(b[9], (uint8_t)'E');
    XCTAssertEqual(b[10], (uint8_t)'B');
    XCTAssertEqual(b[11], (uint8_t)'P');
    // Receiving webp must decode (ImageIO reads webp on iOS 14+).
    CempImageCodecResult *r2 = [self decodeData:webp];
    XCTAssertEqual(r2.width, (NSInteger)256);
    XCTAssertEqual(r2.height, (NSInteger)256);
    [_engine releaseHandle:r2.handle];
  } else {
    NSLog(@"WEBP-ENCODE: unsupported-fallback");
    // The documented fallback: JS requests jpeg instead (ios-prep Task 5).
    XCTAssertEqualObjects(error.domain, CempImageCodecErrorDomain);
    XCTAssertEqual(error.code, CempImageCodecErrorWebPUnsupported);
    NSData *jpeg = [self encodeHandle:r.handle format:@"jpeg" quality:80];
    XCTAssertTrue(jpeg.length > 0);
  }
  [_engine releaseHandle:r.handle];
}

- (void)testHandleLifecycle {
  // Unknown-handle release is a no-op (never throws).
  [_engine releaseHandle:9999];

  CGImageRef img = [self makeSolidImageWidth:16 height:16];
  NSData *png = [self encodeImage:img uti:kUTTypePNG orientation:0];
  CGImageRelease(img);
  CempImageCodecResult *r = [self decodeData:png];

  [_engine releaseHandle:r.handle];
  [_engine releaseHandle:r.handle]; // double release: no-op

  // Use-after-release fails cleanly with the pinned error code.
  NSError *error = nil;
  XCTAssertNil([_engine encodeHandle:r.handle
                              format:@"jpeg"
                             quality:80
                               error:&error]);
  XCTAssertEqual(error.code, CempImageCodecErrorUnknownHandle);
  error = nil;
  XCTAssertNil([_engine resizeHandle:r.handle
                               width:8
                              height:8
                               error:&error]);
  XCTAssertEqual(error.code, CempImageCodecErrorUnknownHandle);
}

- (void)testDecodeRejectsGarbage {
  NSError *error = nil;
  XCTAssertNil([_engine decodeHex:@"00ff00ff" error:&error]);
  XCTAssertEqual(error.code, CempImageCodecErrorDecode);
  error = nil;
  XCTAssertNil([_engine decodeHex:@"zz" error:&error]);
  XCTAssertEqual(error.code, CempImageCodecErrorDecode);
}

@end
