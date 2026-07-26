/* See CempImagePickerEngine.h for the behaviour contract. */

#import "CempImagePickerEngine.h"

#import <MobileCoreServices/MobileCoreServices.h>
#import <UIKit/UIImage.h>

NSInteger const CempImagePickerMaxPickBytes = 64 * 1024 * 1024;
NSErrorDomain const CempImagePickerErrorDomain = @"CempImagePicker";

NS_ASSUME_NONNULL_BEGIN

static NSError *CempPickError(CempImagePickerError code, NSString *message) {
  return [NSError errorWithDomain:CempImagePickerErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}

@implementation CempImagePickerEngine {
  NSLock *_lock;
  CempImagePickerCompletion _Nullable _pending;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _lock = [[NSLock alloc] init];
  }
  return self;
}

#pragma mark - Pending state machine

/* Atomically take the pending completion (leaving none installed). */
- (nullable CempImagePickerCompletion)takePending {
  [_lock lock];
  CempImagePickerCompletion completion = _pending;
  _pending = nil;
  [_lock unlock];
  return completion;
}

- (void)beginPickWithCompletion:(CempImagePickerCompletion)completion {
  [_lock lock];
  CempImagePickerCompletion prior = _pending;
  _pending = [completion copy];
  [_lock unlock];
  if (prior != nil) {
    prior(nil, CempPickError(CempImagePickerErrorSuperseded,
                             @"superseded by a new pick"));
  }
}

- (void)failLaunch {
  CempImagePickerCompletion completion = [self takePending];
  if (completion != nil) {
    completion(nil, CempPickError(CempImagePickerErrorLaunch,
                                  @"could not launch the photo picker"));
  }
}

- (void)invalidate {
  CempImagePickerCompletion completion = [self takePending];
  if (completion != nil) {
    completion(nil, CempPickError(CempImagePickerErrorInvalidated,
                                  @"the photo picker was closed before a result arrived"));
  }
}

#pragma mark - Result processing

- (void)processPickerResults:(nullable NSArray<NSItemProvider *> *)providers {
  // Capture the pending completion NOW (the Kotlin onActivityResult
  // semantics): the async load below settles exactly this pick. A result
  // arriving with no pending pick is dropped immediately, and a slow load
  // started by a stale result can never steal a newer pick's completion.
  CempImagePickerCompletion completion = [self takePending];
  if (completion == nil) {
    return;
  }
  if (providers.count == 0) {
    // User cancel (or no selection): resolve with no bytes — JS maps to null.
    completion(nil, nil);
    return;
  }
  NSItemProvider *provider = providers.firstObject;
  NSString *uti = [self preferredTypeIdentifierFor:provider];
  if (uti == nil) {
    completion(nil, CempPickError(CempImagePickerErrorRead,
                                  @"could not read the selected image"));
    return;
  }
  // Load as public.data when possible: requesting an IMAGE type identifier
  // can route through NSItemProvider's image coercion (re-encode), while
  // the picker must deliver the original file bytes — the codec pipeline
  // owns re-encoding downstream. public.data vends the file untouched.
  NSString *loadUti = [provider hasItemConformingToTypeIdentifier:@"public.data"]
      ? @"public.data"
      : uti;
  // Stream the file representation so the 64 MB cap is enforced DURING the
  // read, never holding more than the cap in memory (the Android
  // readAllBytes idiom).
  [provider loadFileRepresentationForTypeIdentifier:loadUti
                                  completionHandler:^(NSURL *url, NSError *loadError) {
    if (loadError != nil || url == nil) {
      // Some providers only offer an in-memory representation; fall back to
      // data loading and apply the same cap after the fact.
      [self loadDataFromProvider:provider uti:loadUti completion:completion];
      return;
    }
    NSError *readError = nil;
    NSData *data = [self readCapped:url error:&readError];
    if (data == nil) {
      completion(nil, readError);
      return;
    }
    completion([self hexStringFromData:data], nil);
  }];
}

/* Preferred original representations, in order; the UIImage class fallback
 * is handled separately by loadDataFromProvider (documented re-encode). */
- (nullable NSString *)preferredTypeIdentifierFor:(NSItemProvider *)provider {
  static NSArray<NSString *> *preferred = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    preferred = @[ @"public.jpeg", @"public.png", @"public.webp", @"public.heic", @"public.image" ];
  });
  for (NSString *uti in preferred) {
    if ([provider hasItemConformingToTypeIdentifier:uti]) {
      return uti;
    }
  }
  return nil;
}

/* Stream `url` with the hard byte cap. Returns nil with `error` set when
 * the stream exceeds the cap (TooLarge) or cannot be read (Read). */
- (nullable NSData *)readCapped:(NSURL *)url error:(NSError **)error {
  NSInputStream *stream = [NSInputStream inputStreamWithURL:url];
  [stream open];
  if (stream.streamStatus == NSStreamStatusError) {
    if (error) *error = CempPickError(CempImagePickerErrorRead,
                                      @"could not read the selected image");
    return nil;
  }
  NSMutableData *out = [NSMutableData data];
  uint8_t buf[64 * 1024];
  NSInteger total = 0;
  while (YES) {
    NSInteger n = [stream read:buf maxLength:sizeof(buf)];
    if (n < 0) {
      [stream close];
      if (error) *error = CempPickError(CempImagePickerErrorRead,
                                        @"could not read the selected image");
      return nil;
    }
    if (n == 0) break;
    total += n;
    if (total > CempImagePickerMaxPickBytes) {
      [stream close];
      if (error) *error = CempPickError(CempImagePickerErrorTooLarge,
                                        @"the selected image is too large (over 64 MB)");
      return nil;
    }
    [out appendBytes:buf length:(NSUInteger)n];
  }
  [stream close];
  return out;
}

- (void)loadDataFromProvider:(NSItemProvider *)provider
                         uti:(NSString *)uti
                  completion:(CempImagePickerCompletion)completion {
  [provider loadDataRepresentationForTypeIdentifier:uti
                                  completionHandler:^(NSData *data, NSError *loadError) {
    if (loadError == nil && data != nil &&
        data.length <= (NSUInteger)CempImagePickerMaxPickBytes) {
      completion([self hexStringFromData:data], nil);
      return;
    }
    if (loadError == nil && data != nil) {
      completion(nil, CempPickError(CempImagePickerErrorTooLarge,
                                    @"the selected image is too large (over 64 MB)"));
      return;
    }
    [self loadImageObjectFromProvider:provider completion:completion];
  }];
}

/*
 * Last-resort path: the provider only vends a UIImage (no file/data
 * representation — seen with some shared/Cloud-only items). This RE-ENCODES
 * to JPEG at full quality; it is the one place the picker may alter bytes,
 * documented as a deviation from the original-representation goal (the
 * codec pipeline still owns the EXIF strip downstream).
 */
- (void)loadImageObjectFromProvider:(NSItemProvider *)provider
                                     completion:(CempImagePickerCompletion)completion {
  if (![provider canLoadObjectOfClass:UIImage.class]) {
    completion(nil, CempPickError(CempImagePickerErrorRead,
                                  @"could not read the selected image"));
    return;
  }
  [provider loadObjectOfClass:UIImage.class
            completionHandler:^(UIImage *image, NSError *loadError) {
    NSData *data =
        (loadError == nil && image != nil) ? UIImageJPEGRepresentation(image, 1.0) : nil;
    if (data != nil && data.length <= (NSUInteger)CempImagePickerMaxPickBytes) {
      completion([self hexStringFromData:data], nil);
    } else if (data != nil) {
      completion(nil, CempPickError(CempImagePickerErrorTooLarge,
                                    @"the selected image is too large (over 64 MB)"));
    } else {
      completion(nil, CempPickError(CempImagePickerErrorRead,
                                    @"could not read the selected image"));
    }
  }];
}

- (NSString *)hexStringFromData:(NSData *)data {
  static const char digits[] = "0123456789abcdef";
  const uint8_t *bytes = data.bytes;
  NSMutableString *hex = [NSMutableString stringWithCapacity:data.length * 2];
  for (NSUInteger i = 0; i < data.length; i++) {
    [hex appendFormat:@"%c%c", digits[bytes[i] >> 4], digits[bytes[i] & 0xf]];
  }
  return hex;
}

@end

NS_ASSUME_NONNULL_END
