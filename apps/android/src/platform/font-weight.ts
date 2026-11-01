/**
 * Android "Bold text" support that React Native can measure.
 *
 * Android 12+ applies Configuration.fontWeightAdjustment inside TextView when
 * it DRAWS, but React Native measures text without it, so bold-adjusted text
 * is wider than its box and the last word wraps onto a clipped line.
 * MainActivity therefore zeroes the platform adjustment for the app, and the
 * app's Text/TextInput wrappers re-apply it through this function, as a style
 * RN measures. Pure (no react-native import) so it runs under vitest.
 */

/** React Native's accepted `fontWeight` values. */
export type FontWeightValue =
  | "normal"
  | "bold"
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900"
  | 100
  | 200
  | 300
  | 400
  | 500
  | 600
  | 700
  | 800
  | 900
  | "ultralight"
  | "thin"
  | "light"
  | "regular"
  | "medium"
  | "semibold"
  | "condensedBold"
  | "condensed"
  | "heavy"
  | "black";

type NumericWeight = "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900";

const NAMED_WEIGHTS: Readonly<Record<string, number>> = {
  normal: 400,
  regular: 400,
  condensed: 400,
  bold: 700,
  condensedBold: 700,
  ultralight: 100,
  thin: 100,
  light: 300,
  medium: 500,
  semibold: 600,
  heavy: 800,
  black: 900,
};

/** Android's FONT_WEIGHT_ADJUSTMENT_UNDEFINED and documented bounds. */
const ADJUSTMENT_UNDEFINED = 2147483647;
const ADJUSTMENT_LIMIT = 1000;

function numericWeight(weight: FontWeightValue | number | undefined): number {
  if (weight === undefined) return 400;
  if (typeof weight === "number") return weight;
  return NAMED_WEIGHTS[weight] ?? Number(weight);
}

/**
 * The weight Android would draw for `weight` under `adjustment`, snapped to
 * React Native's 100..900 grid. With no adjustment the input is returned
 * unchanged, so an unset weight stays unset (and keeps inheriting).
 */
export function adjustFontWeight(
  weight: FontWeightValue | number | undefined,
  adjustment: number,
): FontWeightValue | number | undefined {
  if (adjustment === 0) return weight;
  const adjusted = Math.round((numericWeight(weight) + adjustment) / 100) * 100;
  return String(Math.min(900, Math.max(100, adjusted))) as NumericWeight;
}

/**
 * Sanitise the native module's value: missing, malformed, or Android's
 * UNDEFINED sentinel means no adjustment; otherwise clamp to ±1000.
 */
export function normaliseFontWeightAdjustment(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw === ADJUSTMENT_UNDEFINED) {
    return 0;
  }
  return Math.min(ADJUSTMENT_LIMIT, Math.max(-ADJUSTMENT_LIMIT, raw));
}
