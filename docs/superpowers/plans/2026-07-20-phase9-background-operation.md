# Phase 9 Background Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedule the existing sync workers with Android WorkManager so messages arrive while the app is backgrounded, and post a notification (without decrypting) when the vault is locked.

**Architecture:** One coalesced WorkManager periodic tick starts a React Native HeadlessJS task. The TypeScript entry checks vault state and either runs the full sync engine or performs a notify-only probe against keystore-cached route tags. All protocol logic stays in TypeScript; Kotlin holds only thin adapters.

**Tech Stack:** React Native 0.83, TypeScript (strict), Kotlin, AndroidX WorkManager, vitest.

**Design doc:** `docs/superpowers/specs/2026-07-20-phase9-background-operation-design.md`

## Global Constraints

- Testnet only. Never introduce a mainnet code path (AGENTS.md rule 11).
- No protocol logic in Kotlin. Kotlin modules are adapters only (design D3).
- Never persist the profile id outside the encrypted database — cache derived route tags only (design D2).
- The locked probe must never open the database and never decrypt (design D1).
- Files importing `react-native` cannot run under vitest. Pure logic lives in RN-free modules; RN adapters stay thin and are verified on-device.
- TypeScript is strict with `exactOptionalPropertyTypes`. Use `readonly` on interface fields, matching the existing code.
- Prettier must pass: `pnpm exec prettier --check .` runs in CI.
- Conventional commit messages (`feat:`, `fix:`, `test:`, `chore:`).

---

## File Structure

**Create (pure TypeScript, unit-tested):**

- `apps/android/src/platform/route-tag-cache-codec.ts` — encode/decode the cache blob, diff outpoints
- `apps/android/src/platform/route-tag-cache-codec.test.ts`
- `apps/android/src/platform/scheduler-coalesce.ts` — collapse N periodic specs into one tick
- `apps/android/src/platform/scheduler-coalesce.test.ts`
- `apps/android/src/background-sync-core.ts` — locked/unlocked branch, fully injected
- `apps/android/src/background-sync-core.test.ts`
- `apps/android/src/platform/locked-probe.ts` — chain query for one route tag, no vault required
- `apps/android/src/platform/locked-probe.test.ts`

**Create (RN/native adapters, verified on-device):**

- `apps/android/src/platform/work-manager-scheduler.ts`
- `apps/android/src/platform/android-notifier.ts`
- `apps/android/src/platform/route-tag-cache.ts`
- `apps/android/src/background-sync.ts`
- `android/app/src/main/java/com/cempmobile/background/CempSyncWorker.kt`
- `android/app/src/main/java/com/cempmobile/background/CempSyncTaskService.kt`
- `android/app/src/main/java/com/cempmobile/background/CempSchedulerModule.kt`
- `android/app/src/main/java/com/cempmobile/background/CempNotifierModule.kt`
- `android/app/src/main/java/com/cempmobile/background/CempBackgroundPackage.kt`

**Modify:**

- `apps/android/android/app/build.gradle` — add WorkManager
- `apps/android/android/app/src/main/AndroidManifest.xml` — POST_NOTIFICATIONS + service
- `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt` — register package
- `apps/android/index.js` — register the headless task
- `apps/android/src/messaging.ts` — expose route tags for caching
- `apps/android/src/app-container.ts` — install real scheduler/notifier, refresh cache on unlock

---

### Task 1: Route-tag cache codec

Pure codec + diff. No React Native imports, so it runs under vitest.

**Files:**

- Create: `apps/android/src/platform/route-tag-cache-codec.ts`
- Test: `apps/android/src/platform/route-tag-cache-codec.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `interface TagCache { readonly tags: readonly string[]; readonly lastSeen: readonly string[] }`, `encodeTagCache(cache: TagCache): Uint8Array`, `decodeTagCache(bytes: Uint8Array): TagCache`, `newOutpoints(lastSeen: readonly string[], current: readonly string[]): string[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/android/src/platform/route-tag-cache-codec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeTagCache, encodeTagCache, newOutpoints } from "./route-tag-cache-codec";

/** Pure codec — no React Native imports, runs under plain vitest. */
describe("route tag cache codec", () => {
  it("round-trips tags and lastSeen", () => {
    const cache = { tags: ["aa", "bb", "cc"], lastSeen: ["0xdead:0"] };
    expect(decodeTagCache(encodeTagCache(cache))).toEqual(cache);
  });

  it("decodes an empty cache", () => {
    expect(decodeTagCache(encodeTagCache({ tags: [], lastSeen: [] }))).toEqual({
      tags: [],
      lastSeen: [],
    });
  });

  it("rejects malformed blobs rather than returning junk", () => {
    expect(() => decodeTagCache(new TextEncoder().encode("not json"))).toThrow();
    expect(() => decodeTagCache(new TextEncoder().encode('{"tags":"nope"}'))).toThrow();
    expect(() => decodeTagCache(new TextEncoder().encode('{"tags":[1],"lastSeen":[]}'))).toThrow();
  });

  it("reports only outpoints not already seen", () => {
    expect(newOutpoints(["a:0"], ["a:0", "b:0", "c:1"])).toEqual(["b:0", "c:1"]);
  });

  it("reports nothing when everything was already seen", () => {
    expect(newOutpoints(["a:0", "b:0"], ["a:0"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/android/src/platform/route-tag-cache-codec.test.ts`
Expected: FAIL — cannot resolve `./route-tag-cache-codec`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/android/src/platform/route-tag-cache-codec.ts`:

```ts
/**
 * Codec for the locked-mode route-tag cache (Phase 9 design D2).
 *
 * The cache holds ONLY derived route tags — never the profile id, which would
 * let a reader derive every epoch's tag. `lastSeen` carries the outpoints the
 * probe has already notified about, so a repeat tick stays silent.
 *
 * Pure: no React Native imports, so it is unit-tested directly.
 */

export interface TagCache {
  /** Hex route tags (previous, current, next epoch). */
  readonly tags: readonly string[];
  /** `txHash:index` of outpoints already notified about. */
  readonly lastSeen: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function encodeTagCache(cache: TagCache): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ tags: [...cache.tags], lastSeen: [...cache.lastSeen] }),
  );
}

export function decodeTagCache(bytes: Uint8Array): TagCache {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("route-tag-cache: blob is not an object");
  }
  const { tags, lastSeen } = parsed as { tags?: unknown; lastSeen?: unknown };
  if (!isStringArray(tags) || !isStringArray(lastSeen)) {
    throw new Error("route-tag-cache: tags and lastSeen must be string arrays");
  }
  return { tags, lastSeen };
}

/** Outpoints in `current` that `lastSeen` does not already contain. */
export function newOutpoints(lastSeen: readonly string[], current: readonly string[]): string[] {
  const seen = new Set(lastSeen);
  return current.filter((outpoint) => !seen.has(outpoint));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/android/src/platform/route-tag-cache-codec.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/android/src/platform/route-tag-cache-codec.ts apps/android/src/platform/route-tag-cache-codec.test.ts
git commit -m "feat(android): route-tag cache codec for locked-mode probe"
```

---

### Task 2: Scheduler coalescing

Collapses the engine's per-worker periodic requests into one WorkManager tick (design D4).

**Files:**

- Create: `apps/android/src/platform/scheduler-coalesce.ts`
- Test: `apps/android/src/platform/scheduler-coalesce.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `WORKMANAGER_MIN_INTERVAL_MS` (number), `interface PeriodicSpec { readonly id: string; readonly intervalMs: number; readonly requiresNetwork: boolean }`, `interface CoalescedTick { readonly intervalMs: number; readonly requiresNetwork: boolean }`, `coalesce(specs: readonly PeriodicSpec[]): CoalescedTick | undefined`.

- [ ] **Step 1: Write the failing test**

Create `apps/android/src/platform/scheduler-coalesce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { WORKMANAGER_MIN_INTERVAL_MS, coalesce } from "./scheduler-coalesce";

describe("scheduler coalescing", () => {
  it("returns undefined when nothing is scheduled", () => {
    expect(coalesce([])).toBeUndefined();
  });

  it("uses the shortest interval across all workers", () => {
    const tick = coalesce([
      { id: "a", intervalMs: 30 * 60_000, requiresNetwork: true },
      { id: "b", intervalMs: 20 * 60_000, requiresNetwork: true },
    ]);
    expect(tick).toEqual({ intervalMs: 20 * 60_000, requiresNetwork: true });
  });

  it("raises intervals below the WorkManager floor", () => {
    const tick = coalesce([{ id: "a", intervalMs: 60_000, requiresNetwork: false }]);
    expect(tick?.intervalMs).toBe(WORKMANAGER_MIN_INTERVAL_MS);
  });

  it("requires network when ANY worker does, since the tick runs them all", () => {
    const tick = coalesce([
      { id: "a", intervalMs: 20 * 60_000, requiresNetwork: false },
      { id: "b", intervalMs: 20 * 60_000, requiresNetwork: true },
    ]);
    expect(tick?.requiresNetwork).toBe(true);
  });

  it("requires no network when no worker does", () => {
    const tick = coalesce([{ id: "a", intervalMs: 20 * 60_000, requiresNetwork: false }]);
    expect(tick?.requiresNetwork).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/android/src/platform/scheduler-coalesce.test.ts`
Expected: FAIL — cannot resolve `./scheduler-coalesce`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/android/src/platform/scheduler-coalesce.ts`:

```ts
/**
 * Collapse the engine's per-worker periodic requests into ONE WorkManager tick
 * (Phase 9 design D4).
 *
 * A literal 1:1 mapping would create a WorkManager request per worker, each
 * booting a fresh React Native JS context — the expensive part of a tick.
 * WorkManager's floor is 15 minutes and every worker interval is >= 15 minutes,
 * so a single tick running `runAllNow()` is behaviourally equivalent.
 *
 * Pure: no React Native imports, so it is unit-tested directly.
 */

/** WorkManager rejects periodic work below 15 minutes. */
export const WORKMANAGER_MIN_INTERVAL_MS = 15 * 60_000;

export interface PeriodicSpec {
  readonly id: string;
  readonly intervalMs: number;
  readonly requiresNetwork: boolean;
}

export interface CoalescedTick {
  readonly intervalMs: number;
  readonly requiresNetwork: boolean;
}

export function coalesce(specs: readonly PeriodicSpec[]): CoalescedTick | undefined {
  if (specs.length === 0) {
    return undefined;
  }
  const shortest = Math.min(...specs.map((spec) => spec.intervalMs));
  return {
    intervalMs: Math.max(shortest, WORKMANAGER_MIN_INTERVAL_MS),
    // The single tick runs every worker, so it must satisfy the strictest
    // constraint any of them declared.
    requiresNetwork: specs.some((spec) => spec.requiresNetwork),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/android/src/platform/scheduler-coalesce.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/android/src/platform/scheduler-coalesce.ts apps/android/src/platform/scheduler-coalesce.test.ts
git commit -m "feat(android): coalesce periodic sync specs into one WorkManager tick"
```

---

### Task 3: Background sync branch logic

The locked/unlocked decision, fully injected so it is testable without React Native, a device, or a chain.

**Files:**

- Create: `apps/android/src/background-sync-core.ts`
- Test: `apps/android/src/background-sync-core.test.ts`

**Interfaces:**

- Consumes: `TagCache`, `newOutpoints` from Task 1.
- Produces: `type BackgroundSyncOutcome = "full" | "notified" | "quiet" | "idle"`, `interface BackgroundSyncDeps { … }` (exact shape below), `runBackgroundSync(deps: BackgroundSyncDeps): Promise<BackgroundSyncOutcome>`.

- [ ] **Step 1: Write the failing test**

Create `apps/android/src/background-sync-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runBackgroundSync, type BackgroundSyncDeps } from "./background-sync-core";
import type { TagCache } from "./platform/route-tag-cache-codec";

function makeDeps(overrides: Partial<BackgroundSyncDeps> = {}): {
  deps: BackgroundSyncDeps;
  calls: string[];
  written: TagCache[];
  notified: number[];
} {
  const calls: string[] = [];
  const written: TagCache[] = [];
  const notified: number[] = [];
  const deps: BackgroundSyncDeps = {
    isVaultUnlocked: () => false,
    runFullSync: () => {
      calls.push("runFullSync");
      return Promise.resolve();
    },
    refreshTagCache: () => {
      calls.push("refreshTagCache");
      return Promise.resolve();
    },
    readTagCache: () => Promise.resolve(undefined),
    writeTagCache: (cache) => {
      written.push(cache);
      return Promise.resolve();
    },
    listOutpointsForTag: () => Promise.resolve([]),
    notify: (count) => {
      notified.push(count);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, calls, written, notified };
}

describe("background sync branch", () => {
  it("runs the full engine and refreshes tags when unlocked", async () => {
    const { deps, calls } = makeDeps({ isVaultUnlocked: () => true });
    expect(await runBackgroundSync(deps)).toBe("full");
    expect(calls).toEqual(["runFullSync", "refreshTagCache"]);
  });

  it("does nothing when locked and no cache exists", async () => {
    const { deps, calls, notified } = makeDeps();
    expect(await runBackgroundSync(deps)).toBe("idle");
    expect(calls).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("notifies once for the count of unseen outpoints", async () => {
    const { deps, calls, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa", "bb"], lastSeen: ["x:0"] }),
      listOutpointsForTag: (tag) => Promise.resolve(tag === "aa" ? ["x:0", "y:0"] : ["z:0"]),
    });
    expect(await runBackgroundSync(deps)).toBe("notified");
    expect(notified).toEqual([2]); // y:0 and z:0 are new; x:0 was seen
    // NEVER runs the engine while locked.
    expect(calls).toEqual([]);
    expect(written).toEqual([{ tags: ["aa", "bb"], lastSeen: ["x:0", "y:0", "z:0"] }]);
  });

  it("stays quiet and still records the sighting when nothing is new", async () => {
    const { deps, notified, written } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: ["x:0"] }),
      listOutpointsForTag: () => Promise.resolve(["x:0"]),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
    expect(written).toEqual([{ tags: ["aa"], lastSeen: ["x:0"] }]);
  });

  it("survives a chain error without throwing", async () => {
    const { deps, notified } = makeDeps({
      readTagCache: () => Promise.resolve({ tags: ["aa"], lastSeen: [] }),
      listOutpointsForTag: () => Promise.reject(new Error("rpc down")),
    });
    expect(await runBackgroundSync(deps)).toBe("quiet");
    expect(notified).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/android/src/background-sync-core.test.ts`
Expected: FAIL — cannot resolve `./background-sync-core`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/android/src/background-sync-core.ts`:

```ts
/**
 * Background tick branch (Phase 9 design D1).
 *
 * Unlocked: run the whole engine, then refresh the route-tag cache so a later
 * locked probe has current tags even across an epoch boundary.
 *
 * Locked or cold start: probe the cached route tags and post ONE notification
 * naming how many new cells are waiting. It never opens the database and never
 * decrypts — the encryption key does not exist in memory while locked.
 *
 * Every dependency is injected so this file has no React Native import and is
 * unit-tested directly.
 */

import { newOutpoints, type TagCache } from "./platform/route-tag-cache-codec";

export type BackgroundSyncOutcome = "full" | "notified" | "quiet" | "idle";

export interface BackgroundSyncDeps {
  /** True only when the vault key is in memory (app alive and unlocked). */
  isVaultUnlocked(): boolean;
  /** `messaging.syncNow()` — the full worker sweep. */
  runFullSync(): Promise<void>;
  /** Re-derive and persist route tags; requires an unlocked vault. */
  refreshTagCache(): Promise<void>;
  readTagCache(): Promise<TagCache | undefined>;
  writeTagCache(cache: TagCache): Promise<void>;
  /** Outpoints (`txHash:index`) currently on-chain for one hex route tag. */
  listOutpointsForTag(tagHex: string): Promise<string[]>;
  /** Post the single "you have mail" notification. */
  notify(newCount: number): Promise<void>;
}

export async function runBackgroundSync(deps: BackgroundSyncDeps): Promise<BackgroundSyncOutcome> {
  if (deps.isVaultUnlocked()) {
    await deps.runFullSync();
    await deps.refreshTagCache();
    return "full";
  }

  const cache = await deps.readTagCache();
  if (cache === undefined || cache.tags.length === 0) {
    return "idle"; // never unlocked since install — nothing to probe with
  }

  const current: string[] = [];
  let answered = 0;
  for (const tag of cache.tags) {
    try {
      current.push(...(await deps.listOutpointsForTag(tag)));
      answered += 1;
    } catch {
      // Per-tag isolation: one stale or failing tag must not suppress the
      // healthy ones. Only tags that answered contribute to `lastSeen`.
      continue;
    }
  }
  if (answered === 0) {
    // Nothing was observed, so recording a sighting would wrongly mark every
    // waiting message as seen. WorkManager retries later.
    return "quiet";
  }

  const unseen = newOutpoints(cache.lastSeen, current);
  if (unseen.length > 0) {
    try {
      // Notify BEFORE recording the sighting: if the notification fails, the
      // next tick must see these outpoints as new again rather than lose them.
      await deps.notify(unseen.length);
    } catch {
      return "quiet";
    }
  }
  // Overwrite only when every tag answered. A tag that failed contributed
  // nothing to `current`, so overwriting would drop outpoints it reported on an
  // earlier tick and re-notify for messages the user has already seen.
  const lastSeen =
    answered === cache.tags.length ? current : [...new Set([...cache.lastSeen, ...current])];
  await deps.writeTagCache({ tags: cache.tags, lastSeen });
  return unseen.length > 0 ? "notified" : "quiet";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/android/src/background-sync-core.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/android/src/background-sync-core.ts apps/android/src/background-sync-core.test.ts
git commit -m "feat(android): background sync branch — full engine unlocked, notify-only locked"
```

---

### Task 4: Native WorkManager scheduler

Kotlin adapter plus the TypeScript `Scheduler` implementation. Not unit-tested (React Native + Android APIs); verified in Task 8.

**Files:**

- Modify: `apps/android/android/app/build.gradle`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/background/CempSyncTaskService.kt`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/background/CempSyncWorker.kt`
- Create: `apps/android/android/app/src/main/java/com/cempmobile/background/CempSchedulerModule.kt`
- Create: `apps/android/src/platform/work-manager-scheduler.ts`

**Interfaces:**

- Consumes: `coalesce`, `PeriodicSpec`, `WORKMANAGER_MIN_INTERVAL_MS` from Task 2.
- Produces: `class WorkManagerScheduler implements Scheduler` (from `@cemp/sync`), native module name `"CempScheduler"` with `schedulePeriodic(intervalMs: number, requiresNetwork: boolean): Promise<void>`, `scheduleOneShot(id: string, delayMs: number): Promise<void>`, `cancel(id: string): Promise<void>`.

- [ ] **Step 1: Add the WorkManager dependency**

In `apps/android/android/app/build.gradle`, inside the existing `dependencies { … }` block, add:

```gradle
    implementation("androidx.work:work-runtime-ktx:2.10.0")
```

- [ ] **Step 2: Create the headless task service**

Create `apps/android/android/app/src/main/java/com/cempmobile/background/CempSyncTaskService.kt`:

```kotlin
package com.cempmobile.background

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JS task registered as "CempBackgroundSync" (apps/android/index.js).
 * Phase 9 design D3: all protocol logic stays in TypeScript, so this service
 * only hands control to the JS runtime.
 */
class CempSyncTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(
      "CempBackgroundSync",
      Arguments.createMap(),
      TASK_TIMEOUT_MS,
      // Allowed in foreground too: a tick that lands while the app is open is
      // harmless (the engine's leases make concurrent runs safe).
      true,
    )

  private companion object {
    const val TASK_TIMEOUT_MS = 120_000L
  }
}
```

- [ ] **Step 3: Create the WorkManager worker**

Create `apps/android/android/app/src/main/java/com/cempmobile/background/CempSyncWorker.kt`:

```kotlin
package com.cempmobile.background

import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Starts the headless JS task on each WorkManager tick. */
class CempSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    return try {
      applicationContext.startService(Intent(applicationContext, CempSyncTaskService::class.java))
      Result.success()
    } catch (error: IllegalStateException) {
      // Android forbids starting the service from the background in some
      // states; WorkManager will retry on the next window.
      Result.retry()
    }
  }
}
```

- [ ] **Step 4: Create the scheduler native module**

Create `apps/android/android/app/src/main/java/com/cempmobile/background/CempSchedulerModule.kt`:

```kotlin
package com.cempmobile.background

import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.TimeUnit

/**
 * WorkManager adapter for the @cemp/sync `Scheduler` (Phase 9 design D4).
 * The TypeScript side has already coalesced every worker's periodic request
 * into a single tick, so this module schedules exactly one periodic work.
 */
class CempSchedulerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempScheduler"

  private fun constraints(requiresNetwork: Boolean): Constraints =
    Constraints.Builder()
      .setRequiredNetworkType(if (requiresNetwork) NetworkType.CONNECTED else NetworkType.NOT_REQUIRED)
      .build()

  @ReactMethod
  fun schedulePeriodic(intervalMs: Double, requiresNetwork: Boolean, promise: Promise) {
    try {
      val request =
        PeriodicWorkRequestBuilder<CempSyncWorker>(intervalMs.toLong(), TimeUnit.MILLISECONDS)
          .setConstraints(constraints(requiresNetwork))
          .build()
      WorkManager.getInstance(reactApplicationContext)
        .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  @ReactMethod
  fun scheduleOneShot(id: String, delayMs: Double, promise: Promise) {
    try {
      val request =
        OneTimeWorkRequestBuilder<CempSyncWorker>()
          .setInitialDelay(delayMs.toLong(), TimeUnit.MILLISECONDS)
          .setConstraints(constraints(true))
          .build()
      WorkManager.getInstance(reactApplicationContext)
        .enqueueUniqueWork(id, ExistingWorkPolicy.REPLACE, request)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  @ReactMethod
  fun cancel(id: String, promise: Promise) {
    try {
      WorkManager.getInstance(reactApplicationContext).cancelUniqueWork(id)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("scheduler_error", error.message, error)
    }
  }

  private companion object {
    const val PERIODIC_WORK = "cemp-sync-tick"
  }
}
```

- [ ] **Step 5: Create the TypeScript scheduler**

Create `apps/android/src/platform/work-manager-scheduler.ts`:

```ts
/**
 * {@link Scheduler} over the app-local CempScheduler Kotlin module
 * (android/app/src/main/java/com/cempmobile/background, AndroidX WorkManager).
 *
 * The engine schedules one periodic request per worker; this adapter coalesces
 * them into a single WorkManager tick (Phase 9 design D4) because booting the
 * React Native JS context is the expensive part. Retry one-shots map 1:1.
 */

import { NativeModules } from "react-native";
import type { Scheduler } from "@cemp/sync";
import { coalesce, type PeriodicSpec } from "./scheduler-coalesce";

interface CempSchedulerNativeModule {
  schedulePeriodic(intervalMs: number, requiresNetwork: boolean): Promise<void>;
  scheduleOneShot(id: string, delayMs: number): Promise<void>;
  cancel(id: string): Promise<void>;
}

const native = NativeModules.CempScheduler as CempSchedulerNativeModule;

export class WorkManagerScheduler implements Scheduler {
  readonly #specs = new Map<string, PeriodicSpec>();

  schedulePeriodic(spec: { id: string; intervalMs: number; requiresNetwork: boolean }): void {
    this.#specs.set(spec.id, spec);
    const tick = coalesce([...this.#specs.values()]);
    if (tick === undefined) {
      return;
    }
    void native.schedulePeriodic(tick.intervalMs, tick.requiresNetwork);
  }

  scheduleOneShot(id: string, delayMs: number): void {
    void native.scheduleOneShot(id, delayMs);
  }

  cancel(id: string): void {
    this.#specs.delete(id);
    void native.cancel(id);
  }
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd apps/android && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/android/android/app/build.gradle apps/android/android/app/src/main/java/com/cempmobile/background apps/android/src/platform/work-manager-scheduler.ts
git commit -m "feat(android): WorkManager scheduler for the sync engine"
```

---

### Task 5: Native notifier and permission

**Files:**

- Create: `apps/android/android/app/src/main/java/com/cempmobile/background/CempNotifierModule.kt`
- Create: `apps/android/src/platform/android-notifier.ts`
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml`

**Interfaces:**

- Consumes: `NOTIFICATION_CHANNELS`, `NotificationContent`, `Notifier` from `@cemp/ui`.
- Produces: `class AndroidNotifier implements Notifier`, `requestNotificationPermission(): Promise<void>`, native module `"CempNotifier"` with `post(id, channel, title, body): Promise<void>`, `cancel(id): Promise<void>`.

- [ ] **Step 1: Declare the permission and service**

In `apps/android/android/app/src/main/AndroidManifest.xml`, add next to the existing `INTERNET` permission:

```xml
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

and inside `<application>`:

```xml
        <service
            android:name="com.cempmobile.background.CempSyncTaskService"
            android:exported="false" />
```

- [ ] **Step 2: Create the notifier native module**

Create `apps/android/android/app/src/main/java/com/cempmobile/background/CempNotifierModule.kt`:

```kotlin
package com.cempmobile.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Notification adapter for the @cemp/ui `Notifier`. Channel ids are chosen by
 * TypeScript (NOTIFICATION_CHANNELS) and are user-visible in system settings,
 * so they must stay stable.
 */
class CempNotifierModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CempNotifier"

  private fun ensureChannel(id: String, importance: Int) {
    val manager =
      reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(id) == null) {
      manager.createNotificationChannel(NotificationChannel(id, id, importance))
    }
  }

  @ReactMethod
  fun post(id: String, channel: String, title: String, body: String, promise: Promise) {
    try {
      val importance =
        if (channel == "messages") NotificationManager.IMPORTANCE_HIGH
        else NotificationManager.IMPORTANCE_LOW
      ensureChannel(channel, importance)
      val notification =
        NotificationCompat.Builder(reactApplicationContext, channel)
          .setSmallIcon(android.R.drawable.ic_dialog_email)
          .setContentTitle(title)
          .setContentText(body)
          .setAutoCancel(true)
          .build()
      // Stable id: a re-post replaces rather than stacks.
      NotificationManagerCompat.from(reactApplicationContext).notify(id.hashCode(), notification)
      promise.resolve(null)
    } catch (error: SecurityException) {
      // POST_NOTIFICATIONS not granted — sync must continue regardless.
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("notifier_error", error.message, error)
    }
  }

  @ReactMethod
  fun cancel(id: String, promise: Promise) {
    try {
      NotificationManagerCompat.from(reactApplicationContext).cancel(id.hashCode())
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("notifier_error", error.message, error)
    }
  }
}
```

- [ ] **Step 3: Create the TypeScript notifier**

Create `apps/android/src/platform/android-notifier.ts`:

```ts
/**
 * {@link Notifier} over the app-local CempNotifier Kotlin module.
 *
 * Notification delivery is best-effort: if the user denied POST_NOTIFICATIONS
 * the native module resolves silently rather than rejecting, because a missing
 * notification must never fail a sync tick.
 */

import { PermissionsAndroid, Platform, NativeModules } from "react-native";
import type { NotificationContent, Notifier } from "@cemp/ui";

interface CempNotifierNativeModule {
  post(id: string, channel: string, title: string, body: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

const native = NativeModules.CempNotifier as CempNotifierNativeModule;

export class AndroidNotifier implements Notifier {
  async post(content: NotificationContent): Promise<void> {
    await native.post(content.id, content.channel, content.title, content.body);
  }

  async cancel(id: string): Promise<void> {
    await native.cancel(id);
  }
}

/**
 * Android 13+ requires a runtime grant. Called once after unlock; a refusal is
 * not an error — notifications are simply dropped afterwards.
 */
export async function requestNotificationPermission(): Promise<void> {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) {
    return;
  }
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/android && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/android/android/app/src/main/AndroidManifest.xml apps/android/android/app/src/main/java/com/cempmobile/background/CempNotifierModule.kt apps/android/src/platform/android-notifier.ts
git commit -m "feat(android): notification channel adapter and runtime permission"
```

---

### Task 6: Register the native package

**Files:**

- Create: `apps/android/android/app/src/main/java/com/cempmobile/background/CempBackgroundPackage.kt`
- Modify: `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt`

**Interfaces:**

- Consumes: `CempSchedulerModule` (Task 4), `CempNotifierModule` (Task 5).
- Produces: `CempBackgroundPackage` registered with the React host.

- [ ] **Step 1: Create the package**

Create `apps/android/android/app/src/main/java/com/cempmobile/background/CempBackgroundPackage.kt`:

```kotlin
package com.cempmobile.background

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers the Phase 9 background modules with the React host. */
class CempBackgroundPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(CempSchedulerModule(reactContext), CempNotifierModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
```

- [ ] **Step 2: Register it**

In `apps/android/android/app/src/main/java/com/cempmobile/MainApplication.kt`, add the import next to the existing KDF import:

```kotlin
import com.cempmobile.background.CempBackgroundPackage
```

and add the package inside the existing `PackageList(this).packages.apply { … }` block, after `add(CempKdfPackage())`:

```kotlin
          add(CempBackgroundPackage())
```

- [ ] **Step 3: Verify the app assembles**

Run: `cd apps/android/android && ./gradlew :app:assembleDebug -q`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/android/android/app/src/main/java/com/cempmobile
git commit -m "feat(android): register the background native package"
```

---

### Task 7: Route-tag cache, headless entry, and wiring

Joins everything: the cache adapter, the headless task, and installing the real scheduler/notifier.

**Files:**

- Create: `apps/android/src/platform/route-tag-cache.ts`
- Create: `apps/android/src/background-sync.ts`
- Modify: `apps/android/index.js`
- Modify: `apps/android/src/messaging.ts`
- Modify: `apps/android/src/app-container.ts`

**Interfaces:**

- Consumes: `encodeTagCache`/`decodeTagCache`/`TagCache` (Task 1), `runBackgroundSync`/`BackgroundSyncDeps` (Task 3), `WorkManagerScheduler` (Task 4), `AndroidNotifier`/`requestNotificationPermission` (Task 5).
- Produces: `class RouteTagCache { read(): Promise<TagCache | undefined>; write(cache: TagCache): Promise<void>; writeTags(tags: readonly string[]): Promise<void> }`, `MessagingService.routeTagsHex(): Promise<string[]>`, `outpointsForTag(tagHex: string, transport?: JsonRpcTransport): Promise<string[]>` from `./platform/locked-probe`.

- [ ] **Step 1: Create the cache adapter**

Create `apps/android/src/platform/route-tag-cache.ts`:

```ts
/**
 * Keystore-wrapped route-tag cache (Phase 9 design D2).
 *
 * Holds ONLY derived route tags — never the profile id, which would let a
 * reader derive every epoch's tag. Wrapped without the biometric flag so the
 * background probe can read it while the vault is locked; the value is a
 * privacy hint, not key material.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PlatformKeyStore } from "@cemp/secure-vault";
import { decodeTagCache, encodeTagCache, type TagCache } from "./route-tag-cache-codec";

const BLOB_KEY = "@cemp/route-tags/blob";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export class RouteTagCache {
  readonly #keystore: PlatformKeyStore;

  constructor(keystore: PlatformKeyStore) {
    this.#keystore = keystore;
  }

  async read(): Promise<TagCache | undefined> {
    const stored = await AsyncStorage.getItem(BLOB_KEY);
    if (stored === null) {
      return undefined;
    }
    try {
      return decodeTagCache(await this.#keystore.unwrap(hexToBytes(stored)));
    } catch {
      // Keystore reset or a malformed blob: treat as "never cached".
      return undefined;
    }
  }

  async write(cache: TagCache): Promise<void> {
    const blob = await this.#keystore.wrap(encodeTagCache(cache));
    await AsyncStorage.setItem(BLOB_KEY, bytesToHex(blob));
  }

  /**
   * Replace the tags while preserving `lastSeen`. Both refresh sites (unlock
   * and the unlocked tick) need exactly this, so it lives here rather than
   * being duplicated at each call site.
   */
  async writeTags(tags: readonly string[]): Promise<void> {
    const existing = await this.read();
    await this.write({ tags, lastSeen: existing?.lastSeen ?? [] });
  }
}
```

- [ ] **Step 2: Expose route tags and tag lookup on MessagingService**

In `apps/android/src/messaging.ts`, add these imports to the existing `@cemp/ckb` import block:

```ts
  currentRoutingEpoch,
```

add `deriveRouteTag` to the existing `@cemp/core` import block, and add these two methods to `MessagingService` (next to `syncNow`):

```ts
  /**
   * Hex route tags for the previous, current and next epoch. Caching the NEXT
   * epoch's tag is what keeps the locked probe working across a rollover
   * (Phase 9 design D2).
   */
  async routeTagsHex(): Promise<string[]> {
    const profileIdHex = await this.myProfileId();
    if (profileIdHex === null) {
      return [];
    }
    const profileId = bytesFrom(`0x${profileIdHex}`);
    const epoch = currentRoutingEpoch(Date.now());
    return [epoch - 1n, epoch, epoch + 1n].map((e) =>
      bytesToHex(deriveRouteTag(profileId, e)),
    );
  }

```

Only `currentRoutingEpoch` and `deriveRouteTag` are needed here; the chain query
lives in Task 7 Step 2b because it must run WITHOUT a vault.

- [ ] **Step 2b: Create the locked probe (with test)**

The probe must work on a cold start, when no `AppContainer` exists and
`MessagingService` cannot be constructed (building it derives identity keys,
which needs an unlocked vault). It therefore builds its own client: a transport
plus endpoints, no keys. This module imports no React Native, so it is
unit-tested.

Create `apps/android/src/platform/locked-probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { JsonRpcTransport } from "@cemp/ckb";
import { outpointsForTag } from "./locked-probe";

describe("locked probe", () => {
  it("returns txHash:index for every cell at the tag", async () => {
    const transport: JsonRpcTransport = {
      call: (_url, method) =>
        method === "get_cells"
          ? Promise.resolve({
              objects: [
                {
                  out_point: { tx_hash: `0x${"ab".repeat(32)}`, index: "0x0" },
                  output: {},
                  output_data: "0x",
                },
              ],
              last_cursor: "0x",
            })
          : Promise.reject(new Error(`unexpected ${method}`)),
    };
    const found = await outpointsForTag("cd".repeat(32), transport);
    expect(found).toEqual([`0x${"ab".repeat(32)}:0`]);
  });

  it("returns nothing when the tag has no cells", async () => {
    const transport: JsonRpcTransport = {
      call: () => Promise.resolve({ objects: [], last_cursor: "0x" }),
    };
    expect(await outpointsForTag("cd".repeat(32), transport)).toEqual([]);
  });
});
```

Run: `npx vitest run apps/android/src/platform/locked-probe.test.ts`
Expected: FAIL — cannot resolve `./locked-probe`.

Create `apps/android/src/platform/locked-probe.ts`:

```ts
/**
 * Chain query for the locked-mode probe (Phase 9 design D1).
 *
 * Deliberately standalone: on a cold start there is no AppContainer, and
 * MessagingService cannot be built because constructing it derives identity
 * keys from an unlocked vault. A route-tag lookup needs neither — only a
 * transport and the pinned testnet endpoints — so this module builds its own
 * client and never touches the vault or the database.
 */

import {
  CempClient,
  fetchJsonRpcTransport,
  findMessageCells,
  type JsonRpcTransport,
} from "@cemp/ckb";
import { CKB_TESTNET } from "@cemp/core";
import { bytesFrom } from "@ckb-ccc/core";

const RPC_TIMEOUT_MS = 15_000;

/** Outpoints (`txHash:index`) currently on-chain for one hex route tag. */
export async function outpointsForTag(
  tagHex: string,
  transport: JsonRpcTransport = fetchJsonRpcTransport(RPC_TIMEOUT_MS),
): Promise<string[]> {
  const cempType = CKB_TESTNET.deployments.cempMessageType;
  if (cempType === null) {
    return [];
  }
  const client = new CempClient({ transport, endpoints: CKB_TESTNET.endpoints[0]! });
  const page = await findMessageCells(
    client,
    { codeHash: cempType.codeHash, hashType: cempType.hashType },
    bytesFrom(`0x${tagHex}`),
  );
  return page.cells.map((cell) => `${cell.outPoint.txHash}:${String(cell.outPoint.index)}`);
}
```

Run: `npx vitest run apps/android/src/platform/locked-probe.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Create the headless entry**

Create `apps/android/src/background-sync.ts`:

```ts
/**
 * HeadlessJS entry for the WorkManager tick (Phase 9).
 *
 * Thin by design: it builds the real dependencies and hands off to
 * {@link runBackgroundSync}, which holds the branch logic and is unit-tested.
 */

import { AppContainer } from "./app-container";
import { runBackgroundSync } from "./background-sync-core";
import { AndroidNotifier } from "./platform/android-notifier";
import { AndroidKeychainKeyStore } from "./platform/android-keystore";
import { outpointsForTag } from "./platform/locked-probe";
import { RouteTagCache } from "./platform/route-tag-cache";

export async function backgroundSyncTask(): Promise<void> {
  const cache = new RouteTagCache(new AndroidKeychainKeyStore());
  const notifier = new AndroidNotifier();
  const container = AppContainer.current();

  await runBackgroundSync({
    isVaultUnlocked: () => container?.state === "ready",
    runFullSync: async () => {
      if (container?.hasMessaging === true) {
        await container.messaging.syncNow();
      }
    },
    refreshTagCache: async () => {
      if (container?.hasMessaging !== true) {
        return;
      }
      await cache.writeTags(await container.messaging.routeTagsHex());
    },
    readTagCache: () => cache.read(),
    writeTagCache: (next) => cache.write(next),
    // Standalone by design: on a cold start there is no container, so this
    // must not depend on one (see Step 2b).
    listOutpointsForTag: (tagHex) => outpointsForTag(tagHex),
    notify: async (count) => {
      await notifier.post({
        id: "locked-inbox",
        channel: "messages",
        title: "CellSend",
        body: `${String(count)} new message${count === 1 ? "" : "s"} — unlock to read`,
      });
    },
  });
}
```

- [ ] **Step 4: Add the container accessor**

In `apps/android/src/app-container.ts`, add a static field and accessor to `AppContainer` so the headless task can reach a live instance, and install the real seams. Add near the other private fields:

```ts
  static #current: AppContainer | null = null;

  /** The live container, when the app process is alive. */
  static current(): AppContainer | null {
    return AppContainer.#current;
  }
```

At the end of `static async init()`, before `return container;`, add:

```ts
AppContainer.#current = container;
```

Change the notifier field from `new NoopNotifier()` to:

```ts
  readonly notifier: Notifier = new AndroidNotifier();
```

adding the import:

```ts
import { AndroidNotifier } from "./platform/android-notifier";
```

- [ ] **Step 5: Refresh tags and request permission on unlock**

In `apps/android/src/app-container.ts`, inside `afterVaultUnlock()` after `this.#setState("ready");`, add:

```ts
void requestNotificationPermission();
void this.#refreshRouteTags();
```

and add the private method plus imports:

```ts
import { requestNotificationPermission } from "./platform/android-notifier";
import { AndroidKeychainKeyStore } from "./platform/android-keystore";
import { RouteTagCache } from "./platform/route-tag-cache";
```

```ts
  /** Cache route tags so the locked background probe has something to query. */
  async #refreshRouteTags(): Promise<void> {
    if (this.#messaging === null) {
      return;
    }
    try {
      const cache = new RouteTagCache(new AndroidKeychainKeyStore());
      await cache.writeTags(await this.#messaging.routeTagsHex());
    } catch {
      // A cache miss only costs locked-mode notifications; never fail unlock.
    }
  }
```

- [ ] **Step 6: Install the real scheduler and start the engine**

In `apps/android/src/messaging.ts`, replace `new InMemoryScheduler()` in the `SyncEngine` construction with `deps.scheduler`, and add `scheduler` to `MessagingService.init`'s deps parameter:

```ts
  static async init(deps: {
    vault: SecureVaultImpl;
    db: SqliteAdapter;
    notifier: Notifier;
    scheduler: Scheduler;
  }): Promise<MessagingService> {
```

adding `Scheduler` to the `@cemp/sync` type imports and removing the now-unused `InMemoryScheduler` import. In `apps/android/src/app-container.ts`, pass it:

```ts
this.#messaging = await MessagingService.init({
  vault: this.vault,
  db: this.#db,
  notifier: this.notifier,
  scheduler: new WorkManagerScheduler(),
});
```

with `import { WorkManagerScheduler } from "./platform/work-manager-scheduler";`.

- [ ] **Step 7: Register the headless task**

In `apps/android/index.js`, add after the existing `registerComponent` call:

```js
import { backgroundSyncTask } from "./src/background-sync";

AppRegistry.registerHeadlessTask("CempBackgroundSync", () => backgroundSyncTask);
```

- [ ] **Step 8: Verify everything compiles and the suite is green**

Run: `cd apps/android && npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

Run: `npx vitest run`
Expected: all tests pass (466 existing + 15 added by Tasks 1–3).

Run: `npx eslint apps/android/src && npx prettier --check .`
Expected: exit 0 for both.

- [ ] **Step 9: Commit**

```bash
git add apps/android/src apps/android/index.js
git commit -m "feat(android): wire WorkManager scheduler, notifier and locked-mode probe"
```

---

### Task 8: On-device verification

The real exit criterion. Both devices from the 2026-07-19 bring-up are already onboarded and funded.

**Files:** none (verification only).

- [ ] **Step 1: Build and install**

```bash
cd apps/android && npx react-native bundle --platform android --dev true --entry-file index.js \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res
cd android && ./gradlew :app:assembleDebug -q
adb -s R5CTC07MPYD install -r app/build/outputs/apk/debug/app-debug.apk
adb -s JY202406200301173 install -r app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 2: Confirm the periodic work is enqueued**

Launch and unlock the app, then run:

```bash
adb -s R5CTC07MPYD shell dumpsys jobscheduler | grep -i cempmobile
```

Expected: a job for `com.cempmobile.debug` appears.

- [ ] **Step 3: Verify backgrounded delivery (unlocked)**

Unlock both devices. Send a message from the Retroid, then press Home on the Samsung (do NOT lock the vault) and wait. Force the tick rather than waiting 15 minutes:

```bash
adb -s R5CTC07MPYD shell cmd jobscheduler run -f com.cempmobile.debug 0
```

Expected: the message arrives and a notification appears without the app being foregrounded.

- [ ] **Step 4: Verify locked-mode notify-only**

On the Samsung open Settings → Lock now. Send a message from the Retroid, wait for it to commit, then force a tick as above.

Expected: a notification reading "1 new message — unlock to read". Unlock and confirm the message body is only then visible.

- [ ] **Step 5: Record the result**

Append the outcome to `apps/android/README.md` under the device-verification section, then commit:

```bash
git add apps/android/README.md
git commit -m "docs(android): record Phase 9 on-device background verification"
```

---

## Self-Review

**Spec coverage.** D1 notify-only → Task 3. D2 keystore-wrapped tags, never the profile id → Tasks 1, 7. D3 all logic in TypeScript → Tasks 3, 4 (Kotlin holds no protocol logic). D4 coalescing → Tasks 2, 4. Components → Tasks 4–7. Data flow → Tasks 3, 7. Failure modes: permission Task 5, `lastSeen` bounded by overwrite Task 3, stable notification id Tasks 3/5, RPC failure Task 3, epoch rollover Task 7 (`routeTagsHex` caches next epoch). Testing → Tasks 1–3 unit, Task 8 on-device. Exit criteria → Task 8.

**Type consistency.** `TagCache` (Task 1) is consumed unchanged by Tasks 3 and 7. `PeriodicSpec`/`coalesce` (Task 2) are consumed by Task 4. `BackgroundSyncDeps` (Task 3) is satisfied field-for-field by Task 7's `backgroundSyncTask`. Native module names `CempScheduler`/`CempNotifier` match `getName()` in Kotlin and `NativeModules.*` in TypeScript. `routeTagsHex` is defined in Task 7 Step 2 and `outpointsForTag` in Step 2b; both are used in Step 3. The locked probe deliberately does NOT depend on AppContainer or MessagingService, because neither exists on a cold start.

**Known follow-ups (deliberately out of scope):** honouring `receipt_request: 0`, and a configurable auto-lock interval.
