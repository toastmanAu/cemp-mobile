module.exports = {
  presets: ["module:@react-native/babel-preset"],
  // Workspace packages compile to ES2020 (`export * as ns`), which the RN
  // preset does not downlevel for dependency files (pnpm monorepo layout).
  plugins: ["@babel/plugin-transform-export-namespace-from"],
};
