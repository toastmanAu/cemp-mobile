/**
 * Declare how tight autonomous chain sync should be while a screen is focused.
 *
 * Screens state what they need rather than driving sync themselves: a chat is
 * waiting on a reply and wants a tight cadence; everywhere else the relaxed
 * default is plenty. The scheduler itself lives on `AppContainer` so it keeps
 * running as the user moves between screens — the bug this replaced was sync
 * that existed ONLY as a focus effect on one screen, which meant no sync at
 * all while a conversation was open.
 *
 * Restores the idle cadence on blur so a screen cannot leave the whole app
 * polling at its rate after the user has moved on.
 */

import { useCallback } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { IDLE_CADENCE_MS } from "./foreground-sync";
import { useAppContainer } from "./navigation";

export function useSyncCadence(cadenceMs: number): void {
  const container = useAppContainer();
  useFocusEffect(
    useCallback(() => {
      container.setSyncCadence(cadenceMs);
      return () => {
        container.setSyncCadence(IDLE_CADENCE_MS);
      };
    }, [container, cadenceMs]),
  );
}
