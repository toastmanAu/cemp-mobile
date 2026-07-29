# Contact Sharing — Slice 1 (share path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can display their own contact bundle as a QR code and share it as a PNG plus caption through the OS share sheet.

**Architecture:** The QR payload is the EXISTING `ContactBundleV1` from `packages/cemp-core/src/contact-bundle.ts` — no new codec. A new `MessagingService#myContactBundle()` composes the bundle from already-exposed identity accessors. QR matrix generation and PNG encoding are pure JS in `packages/cemp-core/src/qr/`, so both are unit-tested on Linux. Only the share sheet itself is native, via a new `CempShare` module in the same launch-and-resolve shape as `CempImagePicker`.

**Tech Stack:** TypeScript, React Native 0.83.10, vitest, `qrcode-generator` (pure JS), Kotlin (Android), Objective-C (iOS), `xcodeproj` ruby gem for Xcode target wiring.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-contact-sharing-design.md`.
- **Do NOT modify `packages/cemp-core/src/contact-bundle.ts`.** It is a spec'd §5.4 wire format, fuzz-tested by `hardening-fuzz.test.ts`. Reuse only.
- The display name NEVER enters the QR. It appears only in the share caption.
- Network is always `CKB_TESTNET.name`; never construct a bundle for another network (AGENTS.md rule 11).
- Never log bundle contents, fingerprints, or the display name beyond what a screen renders (AGENTS.md rule 2).
- All new pure-logic code lives in `packages/cemp-core` (RN-free, vitest-covered). Anything importing `react-native` cannot be unit-tested and belongs in `apps/android/src`.
- Gates that must pass before every commit: `npm run typecheck`, `npx eslint .`, `npx prettier --check .`, `npx vitest run`.
- `SCHEMA_VERSION` bumps 8 → 9 exactly once, in Task 5.

---

### Task 1: `myContactBundle()` on MessagingService

**Files:**

- Modify: `apps/android/src/messaging.ts` (add method near `myFingerprint`, ~line 309)
- Test: `apps/android/src/messaging.test.ts`

**Interfaces:**

- Consumes: existing `identity(): MessagingIdentity`, `myProfileId(): Promise<string | null>`, `myFingerprint(): Promise<string | null>`, and `CKB_TESTNET` from `@cemp/core`.
- Produces: `myContactBundle(): Promise<ContactBundleV1 | null>` — `null` when no profile is published. Task 7 consumes this.

- [ ] **Step 1: Write the failing test**

Add to `apps/android/src/messaging.test.ts`, following the existing harness in that file for constructing a `MessagingService`:

```ts
describe("myContactBundle", () => {
  it("returns null when no profile has been published", async () => {
    const service = await makeTestService({ publishedProfile: null });
    expect(await service.myContactBundle()).toBeNull();
  });

  it("composes a testnet bundle from the published profile", async () => {
    const service = await makeTestService({ publishedProfile: "aa".repeat(32) });
    const bundle = await service.myContactBundle();

    expect(bundle).not.toBeNull();
    expect(bundle!.network).toBe("ckb_testnet");
    expect(bundle!.profileTypeId).toBe(`0x${"aa".repeat(32)}`);
    expect(bundle!.lockScriptHash).toBe(service.identity().lockScriptHash);
    expect(bundle!.address).toBe(service.identity().address);
    expect(bundle!.fingerprint).toBe(await service.myFingerprint());
  });

  it("produces a bundle the existing decoder accepts", async () => {
    const service = await makeTestService({ publishedProfile: "bb".repeat(32) });
    const bundle = await service.myContactBundle();
    expect(decodeContactBundle(encodeContactBundle(bundle!))).toEqual(bundle);
  });
});
```

Import `decodeContactBundle`, `encodeContactBundle` from `@cemp/core` at the top of the test file. If `makeTestService` does not already exist in that file, build the service with the same fixtures the surrounding tests use and add a `publishedProfile` knob to the profile-repository stub.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/android/src/messaging.test.ts -t myContactBundle`
Expected: FAIL — `service.myContactBundle is not a function`

- [ ] **Step 3: Write minimal implementation**

In `apps/android/src/messaging.ts`, directly after `myFingerprint()`:

```ts
  /**
   * This device's contact bundle (spec §5.4) — the QR payload for contact
   * exchange. Null until a profile is published: three of the five fields
   * come from the on-chain profile cell, so no card can exist before it.
   */
  async myContactBundle(): Promise<ContactBundleV1 | null> {
    const profileIdHex = await this.myProfileId();
    if (profileIdHex === null) {
      return null;
    }
    const fingerprint = await this.myFingerprint();
    if (fingerprint === null) {
      return null;
    }
    const id = this.identity();
    return {
      profileTypeId: `0x${profileIdHex}`,
      lockScriptHash: id.lockScriptHash,
      address: id.address,
      fingerprint,
      // Rule 11: never construct a bundle for a network this build is not on.
      network: CKB_TESTNET.name,
    };
  }
```

Add `ContactBundleV1` and `CKB_TESTNET` to the existing `@cemp/core` import.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/android/src/messaging.test.ts`
Expected: PASS, and no previously passing test breaks.

- [ ] **Step 5: Commit**

```bash
git add apps/android/src/messaging.ts apps/android/src/messaging.test.ts
git commit -m "feat(contacts): compose this device's contact bundle for sharing"
```

---

### Task 2: QR module matrix

**Files:**

- Create: `packages/cemp-core/src/qr/matrix.ts`
- Create: `packages/cemp-core/src/qr/matrix.test.ts`
- Modify: `packages/cemp-core/package.json` (add dependency)
- Modify: `packages/cemp-core/src/index.ts` (export)

**Interfaces:**

- Produces: `qrMatrix(text: string): QrMatrix` where `interface QrMatrix { readonly size: number; readonly dark: readonly boolean[] }` — `dark` is row-major, length `size * size`. Tasks 3 and 4 consume this.

- [ ] **Step 1: Add the dependency**

```bash
cd packages/cemp-core && npm pkg set dependencies.qrcode-generator="1.4.4" && cd ../.. && pnpm install
```

`qrcode-generator` is pure JS with no native or DOM dependency. It is used ONLY for its module matrix — never for rendering.

- [ ] **Step 2: Write the failing test**

Create `packages/cemp-core/src/qr/matrix.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { qrMatrix } from "./matrix.js";

describe("qrMatrix", () => {
  it("produces a square matrix whose size matches the module count", () => {
    const m = qrMatrix("HELLO");
    expect(m.size).toBeGreaterThan(0);
    expect(m.dark).toHaveLength(m.size * m.size);
  });

  it("sets the three finder patterns dark at the corners", () => {
    const m = qrMatrix("HELLO");
    const at = (r: number, c: number) => m.dark[r * m.size + c];
    // Finder pattern outer ring corners: top-left, top-right, bottom-left.
    expect(at(0, 0)).toBe(true);
    expect(at(0, m.size - 1)).toBe(true);
    expect(at(m.size - 1, 0)).toBe(true);
    // Bottom-right has no finder pattern.
    expect(at(m.size - 1, m.size - 1)).toBe(false);
  });

  it("is deterministic for the same input", () => {
    expect(qrMatrix("cemp").dark).toEqual(qrMatrix("cemp").dark);
  });

  it("handles a realistic contact bundle payload", () => {
    // ~260 chars — the real payload size this feature must encode.
    const payload = JSON.stringify({
      protocol: "cemp-contact",
      version: 1,
      network: "ckb_testnet",
      profileTypeId: `0x${"ab".repeat(32)}`,
      lockScriptHash: `0x${"cd".repeat(32)}`,
      address: `ckt1${"q".repeat(95)}`,
      fingerprint: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX",
    });
    const m = qrMatrix(payload);
    expect(m.size).toBeGreaterThanOrEqual(45);
    expect(m.dark).toHaveLength(m.size * m.size);
  });

  it("rejects an empty payload", () => {
    expect(() => qrMatrix("")).toThrow(/empty/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/cemp-core/src/qr/matrix.test.ts`
Expected: FAIL — cannot resolve `./matrix.js`

- [ ] **Step 4: Write the implementation**

Create `packages/cemp-core/src/qr/matrix.ts`:

```ts
/**
 * QR module matrix for the contact bundle (spec §5.4 payload).
 *
 * Wraps `qrcode-generator` for its Reed-Solomon error correction only: a
 * wrong matrix fails in the field rather than at build time, which is not a
 * risk worth taking to save a dependency. Rendering is ours (see png.ts).
 */

import qrcode from "qrcode-generator";

export interface QrMatrix {
  /** Module count per side. */
  readonly size: number;
  /** Row-major dark flags, length `size * size`. */
  readonly dark: readonly boolean[];
}

/**
 * Error correction level M (~15% recovery). Chosen over L because a shared
 * card is expected to survive messaging-app recompression; higher levels
 * enlarge the matrix, which costs more than they recover at this payload
 * size.
 */
const ERROR_CORRECTION = "M";

export function qrMatrix(text: string): QrMatrix {
  if (text.length === 0) {
    throw new Error("qrMatrix: refusing to encode an empty payload");
  }
  // Type number 0 = pick the smallest version that fits.
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const dark: boolean[] = new Array<boolean>(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      dark[row * size + col] = qr.isDark(row, col);
    }
  }
  return { size, dark };
}
```

- [ ] **Step 5: Export it**

Add to `packages/cemp-core/src/index.ts`:

```ts
export * from "./qr/matrix.js";
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/cemp-core/src/qr/matrix.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add packages/cemp-core/src/qr/matrix.ts packages/cemp-core/src/qr/matrix.test.ts \
        packages/cemp-core/src/index.ts packages/cemp-core/package.json pnpm-lock.yaml
git commit -m "feat(qr): module matrix for the contact bundle payload"
```

---

### Task 3: PNG writer

**Files:**

- Create: `packages/cemp-core/src/qr/png.ts`
- Create: `packages/cemp-core/src/qr/png.test.ts`
- Modify: `packages/cemp-core/src/index.ts`

**Interfaces:**

- Produces: `encodeGreyscalePng(pixels: Uint8Array, width: number, height: number): Uint8Array`. `pixels` is one byte per pixel, row-major, length `width * height`. Task 4 consumes it.

- [ ] **Step 1: Write the failing test**

Create `packages/cemp-core/src/qr/png.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeGreyscalePng } from "./png.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

describe("encodeGreyscalePng", () => {
  it("starts with the PNG signature", () => {
    const png = encodeGreyscalePng(new Uint8Array(4), 2, 2);
    expect([...png.slice(0, 8)]).toEqual(SIGNATURE);
  });

  it("writes IHDR with the given dimensions, 8-bit greyscale", () => {
    const png = encodeGreyscalePng(new Uint8Array(6), 3, 2);
    // 8 signature + 4 length + 4 type = IHDR data starts at 16.
    expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR");
    expect(readU32(png, 16)).toBe(3);
    expect(readU32(png, 20)).toBe(2);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(0); // colour type 0 = greyscale
  });

  it("ends with IEND", () => {
    const png = encodeGreyscalePng(new Uint8Array(1), 1, 1);
    expect(String.fromCharCode(...png.slice(png.length - 8, png.length - 4))).toBe("IEND");
  });

  it("rejects a pixel buffer that does not match the dimensions", () => {
    expect(() => encodeGreyscalePng(new Uint8Array(3), 2, 2)).toThrow(/length/i);
  });

  it("rejects zero dimensions", () => {
    expect(() => encodeGreyscalePng(new Uint8Array(0), 0, 0)).toThrow(/dimension/i);
  });

  it("produces output an independent decoder accepts", async () => {
    // sharp is a devDependency of this package for exactly this check.
    const { default: sharp } = await import("sharp");
    const pixels = new Uint8Array([0, 255, 255, 0]);
    const png = encodeGreyscalePng(pixels, 2, 2);
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
    const raw = await sharp(Buffer.from(png)).raw().toBuffer();
    expect([...raw]).toEqual([0, 255, 255, 0]);
  });
});
```

- [ ] **Step 2: Add the test-only decoder dependency**

```bash
cd packages/cemp-core && npm pkg set devDependencies.sharp="0.34.4" && cd ../.. && pnpm install
```

`sharp` is a devDependency only — it never ships in the app bundle. It exists so the PNG writer is verified against an independent decoder rather than against our own assumptions.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/cemp-core/src/qr/png.test.ts`
Expected: FAIL — cannot resolve `./png.js`

- [ ] **Step 4: Write the implementation**

Create `packages/cemp-core/src/qr/png.ts`:

```ts
/**
 * Minimal 8-bit greyscale PNG writer.
 *
 * Hand-rolled rather than taken from a dependency because the failure mode is
 * loud: a malformed PNG fails immediately and visibly, so a bug cannot hide.
 * (Contrast qr/matrix.ts, where wrong error correction would produce a code
 * that looks perfect and fails only in the field.)
 *
 * The zlib stream uses STORED (uncompressed) deflate blocks, which are valid
 * deflate and need no compressor. A QR PNG is a few hundred KB uncompressed —
 * irrelevant for a share sheet, and worth it to avoid a zlib dependency.
 */

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_STORED_BLOCK = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib stream over STORED deflate blocks (no compression, no dependency). */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < raw.length; offset += MAX_STORED_BLOCK) {
    const slice = raw.subarray(offset, Math.min(offset + MAX_STORED_BLOCK, raw.length));
    const isFinal = offset + slice.length >= raw.length;
    const len = slice.length;
    parts.push(
      new Uint8Array([
        isFinal ? 1 : 0,
        len & 0xff,
        (len >>> 8) & 0xff,
        ~len & 0xff,
        (~len >>> 8) & 0xff,
      ]),
      slice,
    );
  }
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

export function encodeGreyscalePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0) {
    throw new Error("encodeGreyscalePng: dimensions must be positive");
  }
  if (pixels.length !== width * height) {
    throw new Error(
      `encodeGreyscalePng: pixel length ${pixels.length} does not match ${width}x${height}`,
    );
  }

  // Each scanline is prefixed with filter type 0 (None).
  const raw = new Uint8Array((width + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (width + 1)] = 0;
    raw.set(pixels.subarray(row * width, (row + 1) * width), row * (width + 1) + 1);
  }

  const ihdr = concat([
    u32(width),
    u32(height),
    new Uint8Array([8, 0, 0, 0, 0]), // bit depth 8, greyscale, deflate, adaptive filter, no interlace
  ]);

  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
```

- [ ] **Step 5: Export it**

Add to `packages/cemp-core/src/index.ts`:

```ts
export * from "./qr/png.js";
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/cemp-core/src/qr/png.test.ts`
Expected: PASS (6 tests, including the sharp round-trip)

- [ ] **Step 7: Commit**

```bash
git add packages/cemp-core/src/qr/png.ts packages/cemp-core/src/qr/png.test.ts \
        packages/cemp-core/src/index.ts packages/cemp-core/package.json pnpm-lock.yaml
git commit -m "feat(qr): minimal greyscale PNG writer with stored deflate blocks"
```

---

### Task 4: Bundle → QR PNG

**Files:**

- Create: `packages/cemp-core/src/qr/card-image.ts`
- Create: `packages/cemp-core/src/qr/card-image.test.ts`
- Modify: `packages/cemp-core/src/index.ts`

**Interfaces:**

- Consumes: `qrMatrix` (Task 2), `encodeGreyscalePng` (Task 3), `encodeContactBundle` (existing).
- Produces: `contactCardPng(bundle: ContactBundleV1, opts?: { modulePixels?: number; quietModules?: number }): Uint8Array`. Task 7 consumes it.

- [ ] **Step 1: Write the failing test**

Create `packages/cemp-core/src/qr/card-image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ContactBundleV1 } from "../contact-bundle.js";
import { qrMatrix } from "./matrix.js";
import { contactCardPng } from "./card-image.js";
import { encodeContactBundle } from "../contact-bundle.js";

const BUNDLE: ContactBundleV1 = {
  profileTypeId: `0x${"ab".repeat(32)}`,
  lockScriptHash: `0x${"cd".repeat(32)}`,
  address: `ckt1${"q".repeat(95)}`,
  fingerprint: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX",
  network: "ckb_testnet",
};

describe("contactCardPng", () => {
  it("produces a PNG sized from the matrix, module size and quiet zone", async () => {
    const { default: sharp } = await import("sharp");
    const modules = qrMatrix(encodeContactBundle(BUNDLE)).size;
    const png = contactCardPng(BUNDLE, { modulePixels: 8, quietModules: 4 });

    const expected = (modules + 8) * 8; // quiet zone on both sides
    const meta = await sharp(Buffer.from(png)).metadata();
    expect(meta.width).toBe(expected);
    expect(meta.height).toBe(expected);
  });

  it("renders a white quiet zone and a dark top-left finder", async () => {
    const { default: sharp } = await import("sharp");
    const png = contactCardPng(BUNDLE, { modulePixels: 8, quietModules: 4 });
    const { data, info } = await sharp(Buffer.from(png))
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(data[0]).toBe(255); // top-left corner is quiet zone
    // First module of the finder pattern, inside the quiet zone.
    const x = 4 * 8 + 1;
    const y = 4 * 8 + 1;
    expect(data[y * info.width + x]).toBe(0);
  });

  it("defaults to 8px modules and a 4-module quiet zone", async () => {
    const { default: sharp } = await import("sharp");
    const a = await sharp(Buffer.from(contactCardPng(BUNDLE))).metadata();
    const b = await sharp(
      Buffer.from(contactCardPng(BUNDLE, { modulePixels: 8, quietModules: 4 })),
    ).metadata();
    expect(a.width).toBe(b.width);
  });

  it("rejects a module size below 1", () => {
    expect(() => contactCardPng(BUNDLE, { modulePixels: 0 })).toThrow(/modulePixels/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cemp-core/src/qr/card-image.test.ts`
Expected: FAIL — cannot resolve `./card-image.js`

- [ ] **Step 3: Write the implementation**

Create `packages/cemp-core/src/qr/card-image.ts`:

```ts
/**
 * Contact bundle → shareable QR PNG.
 *
 * The QR carries the bundle and NOTHING else: the display name travels in the
 * share caption, so a forwarded image never leaks a name the sender did not
 * intend to attach (design decision, 2026-07-29).
 */

import { type ContactBundleV1, encodeContactBundle } from "../contact-bundle.js";
import { qrMatrix } from "./matrix.js";
import { encodeGreyscalePng } from "./png.js";

export interface ContactCardPngOptions {
  /** Physical pixels per QR module. Larger survives recompression better. */
  readonly modulePixels?: number;
  /** White margin in modules. The QR spec requires at least 4. */
  readonly quietModules?: number;
}

const DEFAULT_MODULE_PIXELS = 8;
const DEFAULT_QUIET_MODULES = 4;

const WHITE = 255;
const BLACK = 0;

export function contactCardPng(
  bundle: ContactBundleV1,
  opts: ContactCardPngOptions = {},
): Uint8Array {
  const modulePixels = opts.modulePixels ?? DEFAULT_MODULE_PIXELS;
  const quietModules = opts.quietModules ?? DEFAULT_QUIET_MODULES;
  if (!Number.isInteger(modulePixels) || modulePixels < 1) {
    throw new Error("contactCardPng: modulePixels must be a positive integer");
  }
  if (!Number.isInteger(quietModules) || quietModules < 4) {
    throw new Error("contactCardPng: quietModules must be at least 4 (QR spec)");
  }

  const matrix = qrMatrix(encodeContactBundle(bundle));
  const sideModules = matrix.size + quietModules * 2;
  const side = sideModules * modulePixels;

  const pixels = new Uint8Array(side * side).fill(WHITE);
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.dark[row * matrix.size + col]) {
        continue;
      }
      const originY = (row + quietModules) * modulePixels;
      const originX = (col + quietModules) * modulePixels;
      for (let dy = 0; dy < modulePixels; dy++) {
        pixels.fill(
          BLACK,
          (originY + dy) * side + originX,
          (originY + dy) * side + originX + modulePixels,
        );
      }
    }
  }

  return encodeGreyscalePng(pixels, side, side);
}
```

- [ ] **Step 4: Export it**

Add to `packages/cemp-core/src/index.ts`:

```ts
export * from "./qr/card-image.js";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/cemp-core/src/qr/`
Expected: PASS — all three QR test files green.

- [ ] **Step 6: Commit**

```bash
git add packages/cemp-core/src/qr/card-image.ts packages/cemp-core/src/qr/card-image.test.ts \
        packages/cemp-core/src/index.ts
git commit -m "feat(qr): render a contact bundle as a shareable QR PNG"
```

---

### Task 5: settings repository

> **SUPERSEDED IN PART (2026-07-30, owner ruling).** This task originally created
> a new `local_settings` table at schema v9. During implementation a dormant,
> structurally identical `settings` table was found — present since schema v1
> (`migrate.ts`), already in `TABLE_NAMES`, and read or written by no code, with
> no spec document reserving it.
>
> Because migrations are append-only, adding `local_settings` would permanently
> carry two identical key/value tables with one dead forever. The ruling is to
> **reuse the dormant `settings` table and ship no schema change at all**:
> `SCHEMA_VERSION` stays at 8, there is no migration 9, and `TABLE_NAMES` is
> unchanged. The device database stays valid at v8.
>
> `LocalSettingsRepository` and `MY_DISPLAY_NAME_KEY` keep the names below —
> Task 7 depends on them — and only the table their SQL targets changes to
> `settings`. Ignore the migration and `SCHEMA_VERSION` steps in this task;
> everything else stands.

**Files:**

- Modify: `packages/cemp-database/src/schema.ts` (version history comment, `SCHEMA_VERSION`, `TABLE_NAMES`)
- Modify: `packages/cemp-database/src/migrate.ts` (append migration 9)
- Create: `packages/cemp-database/src/repositories/local-settings.ts`
- Create: `packages/cemp-database/src/repositories/local-settings.test.ts`
- Modify: `packages/cemp-database/src/index.ts` (export)

**Interfaces:**

- Produces: `class LocalSettingsRepository { constructor(db: SqliteAdapter); get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; }` and `const MY_DISPLAY_NAME_KEY = "my_display_name"`. Task 7 consumes both.

- [ ] **Step 1: Write the failing test**

Create `packages/cemp-database/src/repositories/local-settings.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "../node.js";
import { migrate } from "../migrate.js";
import { LocalSettingsRepository, MY_DISPLAY_NAME_KEY } from "./local-settings.js";

describe("LocalSettingsRepository", () => {
  let db: NodeSqliteAdapter;
  let repo: LocalSettingsRepository;

  beforeEach(async () => {
    db = new NodeSqliteAdapter();
    await migrate(db);
    repo = new LocalSettingsRepository(db);
  });

  it("returns null for a key that was never set", async () => {
    expect(await repo.get(MY_DISPLAY_NAME_KEY)).toBeNull();
  });

  it("stores and reads back a value", async () => {
    await repo.set(MY_DISPLAY_NAME_KEY, "Phill");
    expect(await repo.get(MY_DISPLAY_NAME_KEY)).toBe("Phill");
  });

  it("overwrites rather than duplicating on a second set", async () => {
    await repo.set(MY_DISPLAY_NAME_KEY, "Phill");
    await repo.set(MY_DISPLAY_NAME_KEY, "Phillip");
    expect(await repo.get(MY_DISPLAY_NAME_KEY)).toBe("Phillip");
    const rows = await db.all("SELECT key FROM local_settings");
    expect(rows).toHaveLength(1);
  });

  it("keeps distinct keys independent", async () => {
    await repo.set("a", "1");
    await repo.set("b", "2");
    expect(await repo.get("a")).toBe("1");
    expect(await repo.get("b")).toBe("2");
  });

  it("round-trips unicode and empty values", async () => {
    await repo.set("emoji", "Phill 🛰️");
    await repo.set("empty", "");
    expect(await repo.get("emoji")).toBe("Phill 🛰️");
    expect(await repo.get("empty")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cemp-database/src/repositories/local-settings.test.ts`
Expected: FAIL — cannot resolve `./local-settings.js`

- [ ] **Step 3: Add the migration**

In `packages/cemp-database/src/schema.ts`, extend the version-history comment with:

```
 * - 9: local settings (contact sharing) — local_settings key/value table,
 *   first key `my_display_name` for the share-sheet caption.
```

then change `export const SCHEMA_VERSION = 8;` to `9`, and add `"local_settings"` to `TABLE_NAMES`.

In `packages/cemp-database/src/migrate.ts`, append to the `MIGRATIONS` array after the `version: 8` entry:

```ts
  {
    version: 9,
    description: "local settings (contact sharing)",
    statements: [
      `CREATE TABLE local_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
    ],
  },
```

- [ ] **Step 4: Write the repository**

Create `packages/cemp-database/src/repositories/local-settings.ts`:

```ts
/**
 * Local key/value settings.
 *
 * Device-scoped preferences that are not part of the CEMP protocol and never
 * leave the device except where a feature explicitly sends them. Lives in the
 * encrypted database for consistency with all other user data, even where a
 * particular value is not itself secret.
 */

import type { SqliteAdapter } from "../adapter.js";

/** Display name used in the contact-card share caption. */
export const MY_DISPLAY_NAME_KEY = "my_display_name";

export class LocalSettingsRepository {
  readonly #db: SqliteAdapter;

  constructor(db: SqliteAdapter) {
    this.#db = db;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.#db.get("SELECT value FROM local_settings WHERE key = ?", [key]);
    return row === undefined ? null : String(row.value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.#db.run(
      `INSERT INTO local_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
```

- [ ] **Step 5: Export it**

Add to `packages/cemp-database/src/index.ts`, alongside the other repository exports:

```ts
export * from "./repositories/local-settings.js";
```

- [ ] **Step 6: Run the full database suite**

Run: `npx vitest run packages/cemp-database/`
Expected: PASS — the new tests plus every existing migration/schema test. `schema.test.ts` asserts against `SCHEMA_VERSION` and `TABLE_NAMES`; if it fails, the bump or the table list is inconsistent.

- [ ] **Step 7: Commit**

```bash
git add packages/cemp-database/src/schema.ts packages/cemp-database/src/migrate.ts \
        packages/cemp-database/src/repositories/local-settings.ts \
        packages/cemp-database/src/repositories/local-settings.test.ts \
        packages/cemp-database/src/index.ts
git commit -m "feat(db): local_settings key/value table (schema v9)"
```

---

### Task 6: `CempShare` native module

**Files:**

- Create: `apps/android/src/platform/native-share.ts`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/share/CempShareModule.kt`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/share/CempSharePackage.kt`
- Modify: `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt`
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml` (FileProvider)
- Create: `apps/android/android/app/src/main/res/xml/file_paths.xml`
- Create: `apps/android/ios/CempShare/CempShare.m`
- Create: `apps/android/ios/scripts/add-share.rb`
- Modify: `apps/android/ios/CempMobile.xcodeproj/project.pbxproj` (generated by the script, committed)

**Interfaces:**

- Produces: `shareImage(png: Uint8Array, caption: string): Promise<void>` from `native-share.ts`. Task 7 consumes it.

**Critical:** iOS sources do NOT reach the app target automatically. Every existing module has a committed one-shot `xcodeproj` script (`add-kdf-targets.rb`, `add-image-codec.rb`, `add-image-picker.rb`, `add-bgtask.rb`) that is run locally, never in CI, with the resulting `project.pbxproj` committed. Skipping this produces a build that succeeds and then throws "the CempShare native module is not linked" at runtime.

- [ ] **Step 1: Write the JS seam**

Create `apps/android/src/platform/native-share.ts`:

```ts
/**
 * Native share sheet over the app-local CempShare module.
 *
 * React Native has no filesystem API, and the share sheet needs a file URL for
 * the image. Writing the temp file natively keeps that detail on one side of
 * the bridge instead of adding a filesystem dependency for a single call.
 *
 * Imports react-native, so — per project convention (native-kdf.ts,
 * native-image-picker.ts) — it cannot run under vitest.
 */

import { NativeModules } from "react-native";
import { bytesToHex } from "./hex";

interface CempShareNativeModule {
  shareImage(pngHex: string, caption: string): Promise<void>;
}

export async function shareImage(png: Uint8Array, caption: string): Promise<void> {
  const m = NativeModules.CempShare as CempShareNativeModule | undefined;
  if (m === undefined) {
    throw new Error("shareImage: the CempShare native module is not linked");
  }
  await m.shareImage(bytesToHex(png), caption);
}
```

- [ ] **Step 2: Write the Android module**

Create `CempShareModule.kt`:

```kotlin
package com.cempmobile.share

import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class CempShareModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempShare"

  @ReactMethod
  fun shareImage(pngHex: String, caption: String, promise: Promise) {
    try {
      val bytes = ByteArray(pngHex.length / 2) { i ->
        ((Character.digit(pngHex[i * 2], 16) shl 4) +
          Character.digit(pngHex[i * 2 + 1], 16)).toByte()
      }
      val dir = File(reactApplicationContext.cacheDir, "share").apply { mkdirs() }
      // Overwritten each time: the card is regenerated on demand, and a stale
      // file must never be shared after the profile changes.
      val file = File(dir, "cellsend-contact.png")
      file.writeBytes(bytes)

      val uri = FileProvider.getUriForFile(
        reactApplicationContext,
        "${reactApplicationContext.packageName}.fileprovider",
        file,
      )
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TEXT, caption)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, null).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactApplicationContext.startActivity(chooser)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("share-error", "could not present the share sheet", e)
    }
  }
}
```

Create `CempSharePackage.kt`:

```kotlin
package com.cempmobile.share

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers {@link CempShareModule} with the React host. */
class CempSharePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CempShareModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
```

- [ ] **Step 3: Register on Android**

In `MainApplication.kt`, next to the existing `add(CempImagePackage())`:

```kotlin
          add(CempSharePackage())
```

Add the import for `com.cempmobile.share.CempSharePackage`.

In `AndroidManifest.xml`, inside `<application>`:

```xml
      <provider
        android:name="androidx.core.content.FileProvider"
        android:authorities="${applicationId}.fileprovider"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
          android:name="android.support.FILE_PROVIDER_PATHS"
          android:resource="@xml/file_paths" />
      </provider>
```

Create `res/xml/file_paths.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
  <cache-path name="share" path="share/" />
</paths>
```

- [ ] **Step 4: Write the iOS module**

Create `apps/android/ios/CempShare/CempShare.m`:

```objc
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
```

- [ ] **Step 5: Wire the iOS Xcode target**

Create `apps/android/ios/scripts/add-share.rb`:

```ruby
# frozen_string_literal: true

# add-share.rb — one-shot project mutation adding the CempShare bridge module
# to the CempMobile app target.
#
# Run once from the ios directory (requires the xcodeproj gem, which ships
# with CocoaPods):  ruby scripts/add-share.rb
# The resulting project.pbxproj change is COMMITTED; this script does NOT run
# in CI. Idempotent: it exits without changes if the file is already present.

require 'xcodeproj'

IOS_DIR = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(IOS_DIR, 'CempMobile.xcodeproj')
SOURCE = 'CempShare/CempShare.m'

project = Xcodeproj::Project.open(PROJECT_PATH)
target = project.targets.find { |t| t.name == 'CempMobile' }
abort 'CempMobile target not found' if target.nil?

already = target.source_build_phase.files_references.any? do |ref|
  ref.path&.end_with?('CempShare.m')
end
if already
  puts 'CempShare.m already in the CempMobile target — nothing to do.'
  exit 0
end

group = project.main_group.find_subpath('CempShare', true)
group.set_source_tree('SOURCE_ROOT')
group.set_path('CempShare')

ref = group.new_reference(File.join(IOS_DIR, SOURCE))
target.add_file_references([ref])
project.save

puts "Added #{SOURCE} to the CempMobile target."
```

Before running it, read the existing `add-image-picker.rb` in the same directory and confirm this matches the conventions there (group placement, source tree); if it differs, prefer the existing script's approach — it is the one proven to produce a working build. Then:

```bash
cd apps/android/ios && ruby scripts/add-share.rb
```

Verify the file landed in the target:

```bash
grep -c CempShare apps/android/ios/CempMobile.xcodeproj/project.pbxproj
```

Expected: non-zero (the existing modules show 22–24 occurrences).

- [ ] **Step 6: Verify it compiles and links**

Run the CI validate build:

```bash
gh workflow run ios-build.yml --ref <branch> -f mode=validate
```

Expected: green. A build that succeeds proves compilation; linkage is proven on device in Task 8.

- [ ] **Step 7: Commit**

```bash
git add apps/android/src/platform/native-share.ts \
        apps/android/android/app/src/main/java/com/cempmobile/share/ \
        apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt \
        apps/android/android/app/src/main/AndroidManifest.xml \
        apps/android/android/app/src/main/res/xml/file_paths.xml \
        apps/android/ios/CempShare/ apps/android/ios/scripts/add-share.rb \
        apps/android/ios/CempMobile.xcodeproj/project.pbxproj
git commit -m "feat(share): CempShare native module for the OS share sheet"
```

---

### Task 7: My Card screen

**Files:**

- Create: `apps/android/src/screens/my-card-screen.tsx`
- Modify: `apps/android/src/navigation.ts` (register the screen)
- Modify: `apps/android/src/screens/contacts-screen.tsx` (entry point)
- Modify: `apps/android/src/app-container.ts` (expose `LocalSettingsRepository` in `AppRepositories`)

**Interfaces:**

- Consumes: `myContactBundle()` (Task 1), `contactCardPng()` (Task 4), `LocalSettingsRepository` + `MY_DISPLAY_NAME_KEY` (Task 5), `shareImage()` (Task 6).
- Produces: a navigable "My contact card" screen.

- [ ] **Step 1: Expose the repository**

In `apps/android/src/app-container.ts`, add `localSettings: LocalSettingsRepository` to the `AppRepositories` interface and construct it in `#openDatabase` alongside the others:

```ts
      localSettings: new LocalSettingsRepository(this.#db),
```

- [ ] **Step 2: Write the screen**

Create `apps/android/src/screens/my-card-screen.tsx`:

```tsx
/**
 * My contact card: the device's contact bundle (spec §5.4) as a scannable QR,
 * plus a share sheet that forwards it as a PNG with a caption.
 *
 * The QR carries the bundle ONLY. The display name rides in the caption, so a
 * forwarded image never leaks a name the sender did not attach.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Button, Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ContactBundleV1 } from "@cemp/core";
import { contactCardPng, encodeContactBundle } from "@cemp/core";
import { MY_DISPLAY_NAME_KEY } from "@cemp/database";
import { useAppContainer } from "../navigation";
import { bytesToBase64 } from "../platform/base64";

export function MyCardScreen(): React.JSX.Element {
  const container = useAppContainer();
  const [bundle, setBundle] = useState<ContactBundleV1 | null>(null);
  const [pngBase64, setPngBase64] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mine = container.hasMessaging ? await container.messaging.myContactBundle() : null;
        const name = (await container.repositories.localSettings.get(MY_DISPLAY_NAME_KEY)) ?? "";
        if (cancelled) return;
        setBundle(mine);
        setDisplayName(name);
        setPngBase64(mine === null ? null : bytesToBase64(contactCardPng(mine)));
      } catch {
        if (!cancelled) setError("Could not build your contact card.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [container]);

  const share = useCallback(async () => {
    if (bundle === null) return;
    setError(null);
    try {
      await container.repositories.localSettings.set(MY_DISPLAY_NAME_KEY, displayName);
      const caption =
        displayName.trim().length > 0
          ? `Add ${displayName.trim()} on CellSend:\n\n${encodeContactBundle(bundle)}`
          : `Add me on CellSend:\n\n${encodeContactBundle(bundle)}`;
      await container.shareContactCard(contactCardPng(bundle), caption);
    } catch {
      setError("Could not open the share sheet.");
    }
  }, [bundle, container, displayName]);

  if (loading) {
    return (
      <View style={styles.container}>
        <Text>Building your card…</Text>
      </View>
    );
  }

  if (bundle === null) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>No contact card yet</Text>
        <Text>
          Your card is built from your on-chain profile. Publish your profile in Settings first,
          then come back here.
        </Text>
        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>My contact card</Text>
      <Text>Have them scan this, or share it to send it on.</Text>
      {pngBase64 !== null ? (
        <Image
          style={styles.qr}
          resizeMode="contain"
          source={{ uri: `data:image/png;base64,${pngBase64}` }}
        />
      ) : null}
      <Text style={styles.label}>Name shown when you share</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="your name"
        autoCapitalize="words"
      />
      <Text style={styles.fingerprint}>{bundle.fingerprint}</Text>
      <Text style={styles.hint}>
        Read this fingerprint aloud to confirm you added the right person.
      </Text>
      <Button title="Share my card" onPress={() => void share()} />
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "600" },
  qr: { width: "100%", aspectRatio: 1, backgroundColor: "#fff" },
  label: { fontSize: 14, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  fingerprint: { fontFamily: "monospace", fontSize: 14, textAlign: "center" },
  hint: { fontSize: 12, color: "#555", textAlign: "center" },
  error: { color: "#b00020" },
});
```

- [ ] **Step 3: Add the container passthrough**

The screen must not import `react-native`-only platform code directly (it already imports `Image`, but the SHARE seam belongs to the container so the screen stays testable later). In `app-container.ts`:

```ts
  /** Present the OS share sheet for a contact card PNG. */
  async shareContactCard(png: Uint8Array, caption: string): Promise<void> {
    await shareImage(png, caption);
  }
```

with `import { shareImage } from "./platform/native-share";` at the top.

- [ ] **Step 4: Verify `bytesToBase64` exists**

Run: `grep -n "bytesToBase64" apps/android/src/platform/base64.ts`
If it is absent, add it next to the existing helpers in that file and cover it in `base64.test.ts`, mirroring the tests already there.

- [ ] **Step 5: Register navigation and the entry point**

In `apps/android/src/navigation.ts`, add the route to `RootStackParamList` (line 15-19):

```ts
export type RootStackParamList = {
  Main: undefined;
  Chat: { conversationId: number; title: string };
  ContactEdit: { contactId?: number };
  MyCard: undefined;
};
```

In `apps/android/src/App.tsx`, add the import next to the other screen imports (~line 23):

```ts
import { MyCardScreen } from "./screens/my-card-screen";
```

and register the screen after the existing `ContactEdit` entry (~line 135):

```tsx
<Stack.Screen name="MyCard" component={MyCardScreen} options={{ title: "My contact card" }} />
```

In `apps/android/src/screens/contacts-screen.tsx`, add a button that navigates to it, using the same `useNavigation` typing the file already uses for `ContactEdit`:

```tsx
<Button title="My contact card" onPress={() => navigation.navigate("MyCard")} />
```

- [ ] **Step 6: Run all gates**

```bash
npm run typecheck && npx eslint . && npx prettier --check . && npx vitest run
```

Expected: all green. No new unit tests here — this file imports `react-native` and cannot run under vitest, which is why the logic it calls was pushed into Tasks 1–5.

- [ ] **Step 7: Commit**

```bash
git add apps/android/src/screens/my-card-screen.tsx apps/android/src/navigation.ts \
        apps/android/src/screens/contacts-screen.tsx apps/android/src/app-container.ts \
        apps/android/src/platform/base64.ts
git commit -m "feat(contacts): my contact card screen with QR and share sheet"
```

---

### Task 8: Device verification

**Files:** none — this task produces evidence, and a docs entry.

This task is not optional. Every layer below the screen is unit-tested; the share sheet and the module linkage are not, and unverified native seams are exactly what shipped the vault database bug on 2026-07-29.

- [ ] **Step 1: Build a device IPA**

```bash
gh workflow run ios-build.yml --ref <branch> -f mode=device
```

Wait for green, then download the artifact and install:

```bash
source ~/.local/share/swiftly/env.sh
xtool install <path>/cempmobile-dev-<n>.ipa
```

- [ ] **Step 2: Verify the no-profile state**

On a wallet with no published profile, open Contacts → My contact card.
Expected: "No contact card yet" with the Settings instruction. No crash, no blank QR.

- [ ] **Step 3: Verify the card renders**

Publish a profile in Settings, return to My contact card.
Expected: a QR renders; the fingerprint below it matches the one shown in Settings.

- [ ] **Step 4: Verify the QR scans**

Point any third-party QR scanner app at the screen.
Expected: it reads JSON beginning `{"protocol":"cemp-contact","version":1,"network":"ckb_testnet"`.

- [ ] **Step 5: Verify the share sheet**

Tap "Share my card". Send it to yourself through a recompressing app (WhatsApp or equivalent).
Expected: the sheet appears; the image and caption arrive; the caption contains the display name.

- [ ] **Step 6: Verify recompression survival — THE RISK GATE**

Save the received image from that app, then scan the SAVED copy with a third-party scanner.
Expected: still decodes. **If it fails, raise `modulePixels` in `contactCardPng` and repeat.** This is the empirical question the spec flags as an open risk, and slice 2's scan-from-photo path depends on the answer.

- [ ] **Step 7: Record the result**

Append a section to `.superpowers/sdd/progress.md` recording: the build number, whether each step passed, and the `modulePixels` value that survived recompression. Commit.

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(sdd): record contact card share path device verification"
```

---

## What slice 1 deliberately excludes

Scanning, in every form. No camera, no photo decode, no paste box, no
add-contact flow. Those are slice 2 (photo + paste + add) and slice 3 (camera),
each with its own plan. Slice 1 ships something usable on its own — a card you
can show and send — and it answers the recompression question that slice 2's
design depends on.
