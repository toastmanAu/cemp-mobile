// Metro configuration for the pnpm monorepo (apps/android).
//
// pnpm lays dependencies out as symlinks into a virtual store, which Metro's
// default resolver historically struggles with. The knobs below are the
// supported monorepo setup (https://metrobundler.dev/docs/configuration):
// watch the workspace root so edits in packages/* rebuild the bundle, give
// the resolver both node_modules roots, and enable symlink + package-exports
// resolution (our packages export via "exports" subpaths, e.g.
// @cemp/database/node). If resolution still bites, the documented fallback is
// `node-linker=hoisted` in a package-local .npmrc (see ADR 0001 + README).
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(workspaceRoot, "node_modules"),
    ],
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
