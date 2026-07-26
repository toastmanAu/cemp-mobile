/*
 * CempImageCodecEngine — the React-free core of the CempImageCodec native
 * module (apps/android/ios/CempImageCodec/CempImageCodec.m), mirroring the
 * Android CempImageCodecModule (android/app/src/main/java/com/cempmobile/
 * imaging) behaviour contract, from ios-prep.md Task 5:
 *
 *   - TWO-PASS SAMPLED DECODE (OOM guard): bounds via
 *     CGImageSourceCopyPropertiesAtIndex, then CGImageSourceCreateThumbnail
 *     with kCGImageSourceThumbnailMaxPixelSize — decoded longest edge is
 *     capped at 2560 px (ample headroom over the pipeline's first 960 px
 *     compress target). A 50 MP photo never materialises at full resolution.
 *   - EXIF orientation baked into pixels at decode
 *     (kCGImageSourceCreateThumbnailWithTransform).
 *   - STRIP BY CONSTRUCTION: output bytes come ONLY from a CGImageDestination
 *     re-encode — no metadata is ever carried across.
 *   - Handle registry: decoded images live behind opaque Int handles;
 *     resize always produces a distinct buffer (alias-safe by construction);
 *     release removes once and a double/unknown release is a no-op.
 *   - Rule 2: errors carry static strings only — never payload data.
 *
 * This class is deliberately free of any React Native import so the XCTest
 * target can link it directly (same pattern as CempKdfCore).
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/** Cap on the decoded longest edge (px) — see the class doc. */
extern NSInteger const CempImageCodecMaxDecodeEdgePx;

/** Error domain; codes below. Messages are static strings (rule 2). */
extern NSErrorDomain const CempImageCodecErrorDomain;

typedef NS_ERROR_ENUM(CempImageCodecErrorDomain, CempImageCodecError) {
  CempImageCodecErrorDecode = 1,
  CempImageCodecErrorUnknownHandle = 2,
  CempImageCodecErrorBadParams = 3,
  CempImageCodecErrorResize = 4,
  CempImageCodecErrorEncode = 5,
  CempImageCodecErrorUnsupportedFormat = 6,
  /** ImageIO on this platform cannot ENCODE webp — JS falls back to jpeg. */
  CempImageCodecErrorWebPUnsupported = 7,
};

@interface CempImageCodecResult : NSObject
@property (nonatomic, readonly) NSInteger handle;
@property (nonatomic, readonly) NSInteger width;
@property (nonatomic, readonly) NSInteger height;
@end

@interface CempImageCodecEngine : NSObject

/** Strict hex helpers (lowercase out; nil on odd length or non-hex input). */
+ (nullable NSData *)dataFromHexString:(NSString *)hex;
+ (NSString *)hexStringFromData:(NSData *)data;

/**
 * Two-pass sampled decode of an encoded image (jpeg/png/webp/…), EXIF
 * orientation baked in, longest edge ≤ 2560 px. On success the image lives
 * in the handle registry until releaseHandle:.
 */
- (nullable CempImageCodecResult *)decodeHex:(NSString *)bytesHex
                                       error:(NSError **)error;

/**
 * Exact-dims resize. Always renders into a fresh buffer, so the returned
 * handle owns pixels independent of the source handle (releasing either
 * handle can never invalidate the other).
 */
- (nullable CempImageCodecResult *)resizeHandle:(NSInteger)handle
                                          width:(NSInteger)width
                                         height:(NSInteger)height
                                          error:(NSError **)error;

/**
 * Re-encode to hex bytes. format is "jpeg" or "webp"; quality is 0–100.
 * WebP encode uses ImageIO (@"public.webp"); where the platform cannot
 * encode webp the error is CempImageCodecErrorWebPUnsupported and the JS
 * policy falls back to jpeg (ios-prep.md Task 5 v1 fallback). Webp DECODE
 * (in decodeHex:) works wherever ImageIO reads it (iOS 14+).
 */
- (nullable NSString *)encodeHandle:(NSInteger)handle
                             format:(NSString *)format
                            quality:(NSInteger)quality
                              error:(NSError **)error;

/** Removes the handle once. Unknown or double release is a no-op. */
- (void)releaseHandle:(NSInteger)handle;

@end

NS_ASSUME_NONNULL_END
