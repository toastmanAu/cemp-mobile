/**
 * Navigation types + the app container React context (spec §16.1).
 */

import { createContext, useContext } from "react";
import type { AppContainer } from "./app-container";

export type TabParamList = {
  Chats: undefined;
  Contacts: undefined;
  Wallet: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Main: undefined;
  Chat: { conversationId: number; title: string };
  ContactEdit: { contactId?: number };
};

export const AppContext = createContext<AppContainer | null>(null);

export function useAppContainer(): AppContainer {
  const container = useContext(AppContext);
  if (container === null) {
    throw new Error("useAppContainer: used outside the AppContext provider");
  }
  return container;
}
