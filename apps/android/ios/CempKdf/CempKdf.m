/*
 * CempKdf — React Native bridge module for the vault password KDFs
 * (argon2id / scrypt), the iOS counterpart of the Android CempKdf Kotlin
 * module (android/app/src/main/java/com/cempmobile/kdf). The JS-facing
 * surface is identical (apps/android/src/platform/native-kdf.ts):
 *
 *   NativeModules.CempKdf.argon2id(passwordHex, saltHex, mKiB, t, p, outBytes)
 *   NativeModules.CempKdf.scrypt(passwordHex, saltHex, logN, r, p, outBytes)
 *     -> Promise<string> (lowercase hex derived key)
 *
 * Legacy RCTBridgeModule on purpose: RN 0.83's bridgeless interop layer
 * picks it up unchanged, and it matches the Kotlin side's simplicity.
 * Derivation runs off the JS/UI queue (global user-initiated queue) and is
 * vector-proven byte-identical to the noble reference engine by
 * CempMobileTests/CempKdfTests.m. Never log inputs or outputs
 * (AGENTS.md rule 2) — timing only.
 */

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

#import "CempKdfCore.h"

@interface CempKdf : NSObject <RCTBridgeModule>
@end

@implementation CempKdf

RCT_EXPORT_MODULE(CempKdf);

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(argon2id:(NSString *)passwordHex
                  saltHex:(NSString *)saltHex
                    mKiB:(nonnull NSNumber *)mKiB
                       t:(nonnull NSNumber *)t
                       p:(nonnull NSNumber *)p
                 outBytes:(nonnull NSNumber *)outBytes
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [CempKdf deriveWithAlg:@"argon2id"
               passwordHex:passwordHex
                  saltHex:saltHex
                       p1:mKiB.unsignedIntValue
                       p2:t.unsignedIntValue
                       p3:p.unsignedIntValue
                 outBytes:outBytes.unsignedIntValue
                 resolver:resolve
                 rejecter:reject];
  });
}

RCT_EXPORT_METHOD(scrypt:(NSString *)passwordHex
                 saltHex:(NSString *)saltHex
                   logN:(nonnull NSNumber *)logN
                      r:(nonnull NSNumber *)r
                      p:(nonnull NSNumber *)p
                outBytes:(nonnull NSNumber *)outBytes
                resolver:(RCTPromiseResolveBlock)resolve
                rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [CempKdf deriveWithAlg:@"scrypt"
               passwordHex:passwordHex
                  saltHex:saltHex
                       p1:logN.unsignedIntValue
                       p2:r.unsignedIntValue
                       p3:p.unsignedIntValue
                 outBytes:outBytes.unsignedIntValue
                 resolver:resolve
                 rejecter:reject];
  });
}

/* p1/p2/p3 are (mKiB, t, p) for argon2id and (logN, r, p) for scrypt. */
+ (void)deriveWithAlg:(NSString *)alg
         passwordHex:(NSString *)passwordHex
            saltHex:(NSString *)saltHex
                 p1:(uint32_t)p1
                 p2:(uint32_t)p2
                 p3:(uint32_t)p3
           outBytes:(uint32_t)outBytes
           resolver:(RCTPromiseResolveBlock)resolve
           rejecter:(RCTPromiseRejectBlock)reject
{
  CFAbsoluteTime startedAt = CFAbsoluteTimeGetCurrent();
  size_t hexLen = (size_t)outBytes * 2 + 1;
  char *outHex = NULL;
  int rc = 1;

  if (outBytes > 0 && (outHex = malloc(hexLen)) != NULL) {
    if ([alg isEqualToString:@"argon2id"]) {
      rc = cemp_kdf_argon2id_hex(passwordHex.UTF8String, saltHex.UTF8String,
                                 p1, p2, p3, outBytes, outHex, hexLen);
    } else {
      rc = cemp_kdf_scrypt_hex(passwordHex.UTF8String, saltHex.UTF8String,
                               p1, p2, p3, outBytes, outHex, hexLen);
    }
  }

  unsigned long elapsedMs =
      (unsigned long)((CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0);
  if (rc == 0) {
    // Timing only — never any input or output bytes (AGENTS.md rule 2).
    NSLog(@"CempKdf: %@ completed in %lums", alg, elapsedMs);
    NSString *result = [NSString stringWithUTF8String:outHex];
    resolve(result);
  } else {
    NSLog(@"CempKdf: %@ failed after %lums", alg, elapsedMs);
    reject(@"kdf-error", [NSString stringWithFormat:@"%@ derivation failed", alg], nil);
  }

  if (outHex != NULL) {
    // Wipe the native-side copy of the derived key hex (the NSString copy's
    // lifetime is managed by the runtime — same documented limit as JS).
    volatile char *v = (volatile char *)outHex;
    for (size_t i = 0; i < hexLen; i++) {
      v[i] = 0;
    }
    free(outHex);
  }
}

@end
