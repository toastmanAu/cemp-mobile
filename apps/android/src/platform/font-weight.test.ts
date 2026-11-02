import { describe, expect, it } from "vitest";
import { adjustFontWeight, normaliseFontWeightAdjustment } from "./font-weight";

/**
 * Android's "Bold text" accessibility setting (Configuration.fontWeightAdjustment,
 * +300 on Pixel) is applied by TextView at DRAW time, but React Native measures
 * text without it — so text drawn bolder than it was measured wraps its last
 * word onto a clipped line. The app turns the platform adjustment off for its
 * activity and re-applies it here, in the style RN measures.
 */
describe("adjustFontWeight", () => {
  it("leaves the weight untouched when there is no adjustment", () => {
    expect(adjustFontWeight(undefined, 0)).toBeUndefined();
    expect(adjustFontWeight("600", 0)).toBe("600");
    expect(adjustFontWeight("bold", 0)).toBe("bold");
  });

  it("treats an unset weight as normal (400), like Android", () => {
    expect(adjustFontWeight(undefined, 300)).toBe("700");
    expect(adjustFontWeight("normal", 300)).toBe("700");
  });

  it.each([
    ["500", "800"],
    ["600", "900"],
    [600, "900"],
    ["300", "600"],
  ] as const)("adds the adjustment to explicit weight %s", (weight, expected) => {
    expect(adjustFontWeight(weight, 300)).toBe(expected);
  });

  it("clamps to React Native's 100..900 range", () => {
    expect(adjustFontWeight("bold", 300)).toBe("900");
    expect(adjustFontWeight("900", 300)).toBe("900");
    expect(adjustFontWeight("200", -300)).toBe("100");
  });

  it.each([
    ["ultralight", "400"],
    ["thin", "400"],
    ["light", "600"],
    ["regular", "700"],
    ["medium", "800"],
    ["semibold", "900"],
    ["condensed", "700"],
    ["condensedBold", "900"],
    ["heavy", "900"],
    ["black", "900"],
  ] as const)("resolves the named weight %s", (weight, expected) => {
    expect(adjustFontWeight(weight, 300)).toBe(expected);
  });

  it("rounds an off-grid result to the nearest hundred", () => {
    expect(adjustFontWeight(450, 300)).toBe("800");
    expect(adjustFontWeight(400, 120)).toBe("500");
  });
});

describe("normaliseFontWeightAdjustment", () => {
  it("passes a real adjustment through", () => {
    expect(normaliseFontWeightAdjustment(300)).toBe(300);
    expect(normaliseFontWeightAdjustment(-100)).toBe(-100);
  });

  it.each([undefined, null, Number.NaN, "300", 2147483647, Infinity])(
    "treats %s (missing, malformed or Android's UNDEFINED sentinel) as no adjustment",
    (raw) => {
      expect(normaliseFontWeightAdjustment(raw)).toBe(0);
    },
  );

  it("clamps to Android's documented -1000..1000 range", () => {
    expect(normaliseFontWeightAdjustment(1500)).toBe(1000);
    expect(normaliseFontWeightAdjustment(-1500)).toBe(-1000);
  });
});
