/**
 * The app's Text and TextInput. Use these instead of react-native's (lint
 * enforces it): they apply the system Bold text setting as a fontWeight
 * React Native MEASURES, instead of leaving Android to bold the text at draw
 * time and clip the last word (see platform/font-weight.ts, MainActivity).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  AppState,
  StyleSheet,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps,
  type TextProps,
  type TextStyle,
} from "react-native";
import { adjustFontWeight } from "../platform/font-weight";
import { readFontWeightAdjustment } from "../platform/native-text-weight";

const FontWeightAdjustmentContext = createContext(0);
/** True inside a Text: an unstyled nested Text inherits its parent's (already adjusted) weight. */
const InsideTextContext = createContext(false);

/** Reads the system adjustment on mount and whenever the app returns to the foreground. */
export function FontWeightAdjustmentProvider({ children }: { children: ReactNode }) {
  const [adjustment, setAdjustment] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      readFontWeightAdjustment()
        .then((value) => {
          if (!cancelled) setAdjustment(value);
        })
        .catch(() => {
          // A failed read leaves the last known value: text stays measurable.
        });
    };
    refresh();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return (
    <FontWeightAdjustmentContext.Provider value={adjustment}>
      {children}
    </FontWeightAdjustmentContext.Provider>
  );
}

/** For non-Text surfaces (navigation header titles, tab labels). */
export function useAdjustedFontWeight(
  weight?: TextStyle["fontWeight"],
): TextStyle["fontWeight"] | undefined {
  return adjustFontWeight(weight, useContext(FontWeightAdjustmentContext)) as
    TextStyle["fontWeight"] | undefined;
}

export function Text(props: TextProps) {
  const adjustment = useContext(FontWeightAdjustmentContext);
  const nested = useContext(InsideTextContext);
  const own = StyleSheet.flatten(props.style)?.fontWeight;
  const skip = adjustment === 0 || (nested && own === undefined);
  const style = skip
    ? props.style
    : [props.style, { fontWeight: adjustFontWeight(own, adjustment) }];
  return (
    <InsideTextContext.Provider value={true}>
      <RNText {...props} style={style as TextProps["style"]} />
    </InsideTextContext.Provider>
  );
}

export function TextInput(props: TextInputProps) {
  const adjustment = useContext(FontWeightAdjustmentContext);
  if (adjustment === 0) return <RNTextInput {...props} />;
  const own = StyleSheet.flatten(props.style)?.fontWeight;
  const style = [props.style, { fontWeight: adjustFontWeight(own, adjustment) }];
  return <RNTextInput {...props} style={style as TextInputProps["style"]} />;
}
