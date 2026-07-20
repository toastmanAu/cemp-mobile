module.exports = function (api) {
  // Metro loads this file via Babel's `extends` (see
  // @react-native/metro-babel-transformer's getBabelRC), and an `env: {...}`
  // block in an extends-ed config does NOT get applied — verified by building
  // a release bundle with `env.production.plugins` set and finding every
  // console call still present. `api.env()` is plain JS and is unaffected;
  // it reports "production" for `react-native bundle --dev false`, which is
  // what a release build runs.
  const isProduction = api.env("production");

  return {
    presets: ["module:@react-native/babel-preset"],
    plugins: [
      // Workspace packages compile to ES2020 (`export * as ns`), which the RN
      // preset does not downlevel for dependency files (pnpm monorepo layout).
      "@babel/plugin-transform-export-namespace-from",
      // The background tick's diagnostics (background-sync.ts,
      // locked-probe.ts) are the only observability that path has, so the log
      // lines stay in the source — but they must never reach a shipped build.
      // logcat is world-readable to anyone with adb and ends up in bug
      // reports, and the tick runs every 15 minutes forever. Debug builds keep
      // every line.
      ...(isProduction ? ["transform-remove-console"] : []),
    ],
  };
};
