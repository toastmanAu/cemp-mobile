/**
 * Metro resolves image imports to an asset reference at bundle time; TypeScript
 * needs to be told their shape (there is no emit, so this is types-only).
 */
declare module "*.png" {
  import type { ImageSourcePropType } from "react-native";
  const source: ImageSourcePropType;
  export default source;
}
