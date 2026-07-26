/*
 * CempKdfTests — conformance proof for the iOS CempKdf C core.
 *
 * Runs the SAME vector cases as tools/kdf-c-core/vectors.txt (bundled with
 * this test target via a project-relative file reference, so there is a
 * single source of truth — packages/cemp-secure-vault/src/kdf.test.ts) through
 * the exact facade the React Native bridge module uses (CempKdfCore.h):
 * hex in, hex out, argon2id m in KiB / v0x13, scrypt N = 2^logN.
 *
 * The expected outputs are byte-identical pins from the noble reference
 * engine; a mismatch fails the test and therefore CI.
 */

#import <XCTest/XCTest.h>

#import "CempKdfCore.h"

@interface CempKdfTests : XCTestCase
@end

@implementation CempKdfTests

- (void)testKdfVectors {
  NSBundle *bundle = [NSBundle bundleForClass:[self class]];
  NSString *path = [bundle pathForResource:@"vectors" ofType:@"txt"];
  XCTAssertNotNil(path, @"vectors.txt missing from the test bundle");
  NSString *contents =
      [NSString stringWithContentsOfFile:path
                                encoding:NSUTF8StringEncoding
                                   error:nil];
  XCTAssertNotNil(contents);

  NSUInteger cases = 0;
  for (NSString *line in [contents componentsSeparatedByCharactersInSet:
                          [NSCharacterSet newlineCharacterSet]]) {
    NSString *trimmed =
        [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    if (trimmed.length == 0 || [trimmed hasPrefix:@"#"]) {
      continue;
    }
    NSArray<NSString *> *fields = [trimmed
        componentsSeparatedByCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    NSMutableArray<NSString *> *tokens = [NSMutableArray array];
    for (NSString *field in fields) {
      if (field.length > 0) {
        [tokens addObject:field];
      }
    }
    XCTAssertEqual(tokens.count, 9, @"malformed vector line: %@", trimmed);
    if (tokens.count != 9) {
      continue;
    }

    NSString *name = tokens[0];
    NSString *alg = tokens[1];
    uint32_t p1 = (uint32_t)tokens[2].integerValue;
    uint32_t p2 = (uint32_t)tokens[3].integerValue;
    uint32_t p3 = (uint32_t)tokens[4].integerValue;
    uint32_t outlen = (uint32_t)tokens[5].integerValue;
    // "-" denotes an empty password/salt.
    NSString *passwordHex = [tokens[6] isEqualToString:@"-"] ? @"" : tokens[6];
    NSString *saltHex = [tokens[7] isEqualToString:@"-"] ? @"" : tokens[7];
    NSString *expected = tokens[8];

    size_t hexLen = (size_t)outlen * 2 + 1;
    char *got = malloc(hexLen);
    XCTAssertNotNil(got);
    int rc;
    if ([alg isEqualToString:@"argon2id"]) {
      rc = cemp_kdf_argon2id_hex(passwordHex.UTF8String, saltHex.UTF8String,
                                 p1, p2, p3, outlen, got, hexLen);
    } else if ([alg isEqualToString:@"scrypt"]) {
      rc = cemp_kdf_scrypt_hex(passwordHex.UTF8String, saltHex.UTF8String,
                               p1, p2, p3, outlen, got, hexLen);
    } else {
      rc = -1;
      XCTFail(@"unknown alg \"%@\" in vector %@", alg, name);
    }
    XCTAssertEqual(rc, 0, @"%@ derivation failed", name);
    if (rc == 0) {
      XCTAssertEqualObjects([NSString stringWithUTF8String:got], expected,
                            @"%@ output mismatch", name);
      NSLog(@"PASS %@", name);
    }
    free(got);
    cases++;
  }
  XCTAssertGreaterThan(cases, 0, @"no vector cases found in vectors.txt");
  NSLog(@"%lu vector case(s) executed", (unsigned long)cases);
}

@end
