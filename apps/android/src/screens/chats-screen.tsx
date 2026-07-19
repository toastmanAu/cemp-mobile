/**
 * Chats tab (spec §16.2): conversation list with avatar, name, last-message
 * preview, unread count, driven by {@link ConversationListViewModel}.
 */

import React, { useCallback, useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ConversationListViewModel } from "@cemp/ui";
import type { ConversationListItem } from "@cemp/database";
import { useAppContainer, type RootStackParamList } from "../navigation";

export function ChatsScreen(): React.JSX.Element {
  const container = useAppContainer();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [vm] = useState(() => new ConversationListViewModel(container.repositories.conversations));
  const [items, setItems] = useState<readonly ConversationListItem[]>([]);
  const [syncStatus, setSyncStatus] = useState("");

  useEffect(() => {
    const unsubscribe = vm.subscribe(() => {
      setItems(vm.items);
    });
    void vm.refresh();
    return unsubscribe;
  }, [vm]);

  const onRefresh = useCallback(() => void vm.refresh(), [vm]);

  // Foreground sync on tab focus (discovery, receipts, watches, balances).
  // Failures stay quiet here — the workers retry with backoff (rule 5).
  useFocusEffect(
    useCallback(() => {
      if (!container.hasMessaging) return;
      setSyncStatus("syncing…");
      void container.messaging
        .syncNow()
        .then((results) => {
          const failed = Object.entries(results)
            .filter(([, r]) => r !== "success")
            .map(([id, r]) => `${id}:${r}`);
          setSyncStatus(
            failed.length === 0
              ? `synced ${new Date().toLocaleTimeString()}`
              : `failed: ${failed.join(", ")}`,
          );
        })
        .catch((e: unknown) =>
          setSyncStatus(`sync error: ${e instanceof Error ? e.message : String(e)}`),
        )
        .finally(() => void vm.refresh());
    }, [container, vm]),
  );

  return (
    <View style={styles.screen}>
      {syncStatus !== "" ? <Text style={styles.syncStatus}>{syncStatus}</Text> : null}
      <FlatList
        data={items as ConversationListItem[]}
        keyExtractor={(item) => String(item.id)}
        refreshing={vm.loading}
        onRefresh={onRefresh}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text>No conversations yet. Add a contact to start.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              navigation.navigate("Chat", {
                conversationId: item.id,
                title: item.contactDisplayName,
              });
            }}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {item.contactDisplayName.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.name}>{item.contactDisplayName}</Text>
              <Text numberOfLines={1} style={styles.preview}>
                {item.lastMessageBody ?? ""}
              </Text>
            </View>
            {item.unreadCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.unreadCount}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  syncStatus: { fontSize: 11, color: "#666", paddingHorizontal: 12, paddingTop: 4 },
  empty: { padding: 32, alignItems: "center" },
  row: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#4a6fa5",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  rowBody: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600" },
  preview: { color: "#666", marginTop: 2 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#b00020",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
