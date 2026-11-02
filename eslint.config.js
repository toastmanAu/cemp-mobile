import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/target/**",
      "reference/**",
      "contracts/**",
      // Agent session scratch (git-ignored, regenerates outside the repo's control).
      ".remember/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // React Native bundler configs are CommonJS with Node globals.
    files: ["apps/android/*.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "writable",
        require: "readonly",
        __dirname: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Android Bold text: react-native's Text/TextInput are measured without
    // the system font-weight adjustment and get their last word clipped. The
    // app's wrappers apply it as a measured style (components/text.tsx).
    files: ["apps/android/src/**/*.{ts,tsx}"],
    ignores: ["apps/android/src/components/text.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: ["Text", "TextInput"],
              message: "Import Text/TextInput from components/text (Android Bold text support).",
            },
          ],
        },
      ],
    },
  },
  {
    // Node CLI tooling (CI gates): ESM with Node + fetch globals.
    files: ["tools/**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
      },
    },
  },
);
