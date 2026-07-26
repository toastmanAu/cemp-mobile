/*
 * CempImagePickerTests — headless engine tests for the iOS photo picker
 * (CempImagePicker/CempImagePickerEngine.{h,m}), proving the contract the
 * Android CempImagePickerModule implements:
 *
 *   - single in-flight pick: a second pick rejects the first (superseded),
 *     and a late result with no pending pick is dropped, never misdelivered
 *   - 64 MB byte cap enforced during the read (oversize rejects TooLarge)
 *   - cancel resolves with no bytes and no error (JS maps to null)
 *   - invalidate rejects a pending pick; the engine stays usable afterwards
 *   - the result path delivers the provider's ORIGINAL bytes as lowercase hex
 *
 * PHPickerViewController presentation itself is not testable headlessly —
 * that is a first-device item (ios-prep.md).
 */

#import <XCTest/XCTest.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#import <MobileCoreServices/MobileCoreServices.h>

#import "CempImagePickerEngine.h"

@interface CempImagePickerTests : XCTestCase
@end

@implementation CempImagePickerTests {
  CempImagePickerEngine *_engine;
}

- (void)setUp {
  [super setUp];
  _engine = [[CempImagePickerEngine alloc] init];
}

#pragma mark - Helpers

/*
 * File-backed provider: NSItemProvider RE-ENCODES in-memory image items
 * (initWithItem: round-trips a PNG through ImageIO and the bytes change),
 * while real PHPicker providers wrap asset files. Writing a temp file and
 * using initWithContentsOfURL: mirrors the real thing — original bytes.
 */
- (NSItemProvider *)providerWithData:(NSData *)data uti:(NSString *)uti {
  NSString *ext = @{
    @"public.jpeg" : @"jpg",
    @"public.png" : @"png",
    @"public.webp" : @"webp",
  }[uti];
  XCTAssertNotNil(ext, @"no extension mapping for %@", uti);
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"picker-test-%@.%@",
       NSUUID.UUID.UUIDString, ext]];
  XCTAssertTrue([data writeToFile:path atomically:YES]);
  return [[NSItemProvider alloc] initWithContentsOfURL:
      [NSURL fileURLWithPath:path]];
}

/* Small solid-color image, encoded. */
- (NSData *)makeImageDataWidth:(NSInteger)w
                        height:(NSInteger)h
                           uti:(CFStringRef)uti {
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(
      NULL, (size_t)w, (size_t)h, 8, 0, cs,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrderDefault);
  CGColorSpaceRelease(cs);
  CGContextSetRGBFillColor(ctx, 0.3, 0.5, 0.7, 1.0);
  CGContextFillRect(ctx, CGRectMake(0, 0, w, h));
  CGImageRef image = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx);
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dest =
      CGImageDestinationCreateWithData((CFMutableDataRef)data, uti, 1, NULL);
  CGImageDestinationAddImage(dest, image, NULL);
  CGImageDestinationFinalize(dest);
  CFRelease(dest);
  CGImageRelease(image);
  return data;
}

- (NSData *)dataFromHex:(NSString *)hex {
  NSMutableData *data = [NSMutableData dataWithLength:hex.length / 2];
  uint8_t *out = data.mutableBytes;
  for (NSUInteger i = 0; i < hex.length / 2; i++) {
    NSInteger hi = [self hexVal:[hex characterAtIndex:2 * i]];
    NSInteger lo = [self hexVal:[hex characterAtIndex:2 * i + 1]];
    XCTAssertTrue(hi >= 0 && lo >= 0, @"bad hex at %lu", (unsigned long)i);
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return data;
}

- (NSInteger)hexVal:(unichar)c {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Begin a pick, process `providers`, and run `verify` on settlement. */
- (void)settlePickWithProviders:(NSArray<NSItemProvider *> *)providers
                         verify:(void (^)(NSString *hex, NSError *error))verify {
  XCTestExpectation *settled = [self expectationWithDescription:@"pick settled"];
  [_engine beginPickWithCompletion:^(NSString *hex, NSError *error) {
    verify(hex, error);
    [settled fulfill];
  }];
  [_engine processPickerResults:providers];
  [self waitForExpectations:@[settled] timeout:30];
}

#pragma mark - Tests

- (void)testSingleInFlightSupersedesAndLateResultDropped {
  NSData *png = [self makeImageDataWidth:8 height:8 uti:kUTTypePNG];

  __block NSError *firstError = nil;
  __block BOOL firstSettled = NO;
  [_engine beginPickWithCompletion:^(NSString *hex, NSError *error) {
    firstSettled = YES;
    firstError = error;
  }];

  XCTestExpectation *secondSettled = [self expectationWithDescription:@"second pick settled"];
  __block NSString *secondHex = nil;
  [_engine beginPickWithCompletion:^(NSString *hex, NSError *error) {
    secondHex = hex;
    [secondSettled fulfill];
  }];

  // The first pick was rejected synchronously by the supersede.
  XCTAssertTrue(firstSettled);
  XCTAssertEqual(firstError.code, CempImagePickerErrorSuperseded);

  [_engine processPickerResults:@[ [self providerWithData:png uti:@"public.png"] ]];
  [self waitForExpectations:@[secondSettled] timeout:30];
  XCTAssertEqualObjects([self dataFromHex:secondHex], png);

  // A late result with no pending pick is dropped silently (no crash)…
  NSData *other = [self makeImageDataWidth:4 height:4 uti:kUTTypePNG];
  [_engine processPickerResults:@[ [self providerWithData:other uti:@"public.png"] ]];

  // …and never misdelivered: a subsequent pick settles with ITS OWN result.
  [self settlePickWithProviders:@[ [self providerWithData:png uti:@"public.png"] ]
                         verify:^(NSString *hex, NSError *error) {
    XCTAssertNil(error);
    XCTAssertEqualObjects([self dataFromHex:hex], png);
  }];
}

- (void)testByteCapRejectsOversizeAndAcceptsWithinLimit {
  NSMutableData *oversize =
      [NSMutableData dataWithLength:(NSUInteger)CempImagePickerMaxPickBytes + 1];
  [self settlePickWithProviders:@[ [self providerWithData:oversize uti:@"public.jpeg"] ]
                         verify:^(NSString *hex, NSError *error) {
    XCTAssertNil(hex);
    XCTAssertEqual(error.code, CempImagePickerErrorTooLarge);
  }];

  NSData *jpeg = [self makeImageDataWidth:32 height:32 uti:kUTTypeJPEG];
  [self settlePickWithProviders:@[ [self providerWithData:jpeg uti:@"public.jpeg"] ]
                         verify:^(NSString *hex, NSError *error) {
    XCTAssertNil(error);
    XCTAssertNotNil(hex);
    XCTAssertEqualObjects([self dataFromHex:hex], jpeg);
  }];
}

- (void)testCancelResolvesNil {
  [self settlePickWithProviders:@[] verify:^(NSString *hex, NSError *error) {
    XCTAssertNil(hex);
    XCTAssertNil(error);
  }];
  // nil providers is the same cancel path (defensive parity with the shell).
  XCTestExpectation *settled = [self expectationWithDescription:@"cancel settled"];
  [_engine beginPickWithCompletion:^(NSString *hex, NSError *error) {
    XCTAssertNil(hex);
    XCTAssertNil(error);
    [settled fulfill];
  }];
  [_engine processPickerResults:nil];
  [self waitForExpectations:@[settled] timeout:5];
}

- (void)testInvalidateRejectsPendingAndEngineStaysUsable {
  XCTestExpectation *rejected = [self expectationWithDescription:@"pending rejected"];
  [_engine beginPickWithCompletion:^(NSString *hex, NSError *error) {
    XCTAssertNil(hex);
    XCTAssertEqual(error.code, CempImagePickerErrorInvalidated);
    [rejected fulfill];
  }];
  [_engine invalidate];
  [self waitForExpectations:@[rejected] timeout:5];

  // The engine remains usable after invalidate.
  NSData *png = [self makeImageDataWidth:8 height:8 uti:kUTTypePNG];
  [self settlePickWithProviders:@[ [self providerWithData:png uti:@"public.png"] ]
                         verify:^(NSString *hex, NSError *error) {
    XCTAssertNil(error);
    XCTAssertEqualObjects([self dataFromHex:hex], png);
  }];
}

- (void)testResultDeliversOriginalBytesUnaltered {
  NSData *jpeg = [self makeImageDataWidth:64 height:48 uti:kUTTypeJPEG];
  [self settlePickWithProviders:@[ [self providerWithData:jpeg uti:@"public.jpeg"] ]
                         verify:^(NSString *hex, NSError *error) {
    XCTAssertNil(error);
    // Original representation: the resolved bytes are the identical file
    // bytes, lowercase-hex encoded — never re-encoded.
    XCTAssertEqualObjects([self dataFromHex:hex], jpeg);
    XCTAssertEqualObjects(hex, hex.lowercaseString, @"hex must be lowercase");
  }];
}

@end
