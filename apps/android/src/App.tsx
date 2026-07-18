/**
 * Root component: vault gate → main navigation.
 *
 * The vault lifecycle owns the top of the tree (spec §16): while the vault
 * is uninitialized the onboarding (create/import) screen shows; while locked,
 * the unlock screen; only in the ready state does the tab navigator (Chats /
 * Contacts / Wallet / Settings, §16.1) mount.
 */

import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { AppContainer, type AppContainerState } from "./app-container";
import { AppContext, type RootStackParamList, type TabParamList } from "./navigation";
import { ChatScreen } from "./screens/chat-screen";
import { ChatsScreen } from "./screens/chats-screen";
import { ContactEditScreen } from "./screens/contact-edit-screen";
import { ContactsScreen } from "./screens/contacts-screen";
import { SettingsScreen } from "./screens/settings-screen";
import { UnlockScreen } from "./screens/unlock-screen";
import { VaultOnboardingScreen } from "./screens/vault-onboarding-screen";
import { WalletScreen } from "./screens/wallet-screen";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

function MainTabs(): React.JSX.Element {
  return (
    <Tabs.Navigator>
      <Tabs.Screen name="Chats" component={ChatsScreen} />
      <Tabs.Screen name="Contacts" component={ContactsScreen} />
      <Tabs.Screen name="Wallet" component={WalletScreen} />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

export function App(): React.JSX.Element {
  const [container, setContainer] = useState<AppContainer | null>(null);
  const [containerState, setContainerState] = useState<AppContainerState>("loading");
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    AppContainer.init()
      .then((instance) => {
        if (cancelled) {
          return;
        }
        setContainer(instance);
        setContainerState(instance.state);
        instance.subscribe(() => {
          setContainerState(instance.state);
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setInitError(e instanceof Error ? e.message : "failed to initialize");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (initError !== null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text>Something went wrong starting CellSend.</Text>
        <Text>{initError}</Text>
      </View>
    );
  }
  if (container === null || containerState === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>CellSend</Text>
      </View>
    );
  }

  return (
    <AppContext.Provider value={container}>
      {containerState === "uninitialized" ? (
        <VaultOnboardingScreen />
      ) : containerState === "locked" ? (
        <UnlockScreen />
      ) : (
        <NavigationContainer>
          <Stack.Navigator>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={({ route }) => ({ title: route.params.title })}
            />
            <Stack.Screen
              name="ContactEdit"
              component={ContactEditScreen}
              options={{ title: "Edit contact" }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      )}
    </AppContext.Provider>
  );
}
