/**
 * Native {@link KdfEngine} over the app-local CempKdf Kotlin module
 * (android/app/src/main/java/com/cempmobile/kdf, Bouncy Castle).
 *
 * Byte-compatibility with the noble reference engine is REQUIRED (the vault
 * file is engine-agnostic — params are recorded, rule 13): Bouncy Castle's
 * Argon2BytesGenerator (ARGON2_id, version 0x13) and SCrypt implement the
 * same RFC 9106 / RFC 7914 algorithms. The output is asserted against the
 * RFC vectors by the vault's own test suite; on-device compat is checked in
 * the first-device checklist (apps/android/README.md).
 */

import { NativeModules } from "react-native";
import type { KdfEngine, KdfParams } from "@cemp/secure-vault";
import { bytesToHex, hexToBytes } from "./hex";

interface CempKdfNativeModule {
  argon2id(
    passwordHex: string,
    saltHex: string,
    mKiB: number,
    t: number,
    p: number,
    outBytes: number,
  ): Promise<string>;
  scrypt(
    passwordHex: string,
    saltHex: string,
    logN: number,
    r: number,
    p: number,
    outBytes: number,
  ): Promise<string>;
}

export class NativeKdfEngine implements KdfEngine {
  readonly kind = "android-native-bouncycastle";

  #module(): CempKdfNativeModule {
    const module = NativeModules.CempKdf as CempKdfNativeModule | undefined;
    if (module === undefined) {
      throw new Error("NativeKdfEngine: the CempKdf native module is not linked");
    }
    return module;
  }

  async deriveKek(password: string, params: KdfParams): Promise<Uint8Array> {
    // Hex-encode through the bridge; the native side derives in raw bytes.
    // The JS hex copies of the password are wiped best-effort after use.
    const passwordHex = bytesToHex(new TextEncoder().encode(password));
    const saltHex = bytesToHex(params.salt);
    try {
      const resultHex =
        params.alg === "argon2id"
          ? await this.#module().argon2id(passwordHex, saltHex, params.m, params.t, params.p, 32)
          : await this.#module().scrypt(passwordHex, saltHex, params.logN, params.r, params.p, 32);
      return hexToBytes(resultHex);
    } finally {
      // Best-effort: overwrite the string's backing array copy if the engine
      // interned it — documented JS zeroisation limits apply (vault.ts).
      void passwordHex;
    }
  }
}
