/**
 * React Native binding for the route-tag cache (Phase 9 design D2).
 *
 * Thin by design: all logic lives in `route-tag-cache-core.ts`, which has no
 * React Native import and is unit-tested directly. This file only wires that
 * core to AsyncStorage and the route-tag keychain entry.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { AndroidRouteTagKeyStore } from "./android-keystore";
import { RouteTagCacheCore } from "./route-tag-cache-core";

export { ROUTE_TAG_BLOB_KEY, RouteTagCacheCore } from "./route-tag-cache-core";

export function createRouteTagCache(): RouteTagCacheCore {
  return new RouteTagCacheCore(new AndroidRouteTagKeyStore(), AsyncStorage);
}
