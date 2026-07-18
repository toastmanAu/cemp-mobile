/**
 * Contacts tab (spec §16.3): contact list + search, add button, tap to edit.
 * Driven by {@link ContactListViewModel}.
 */

import React, { useEffect, useState } from "react";
import {
  Button,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { Contact } from "@cemp/database";
import { ContactListViewModel } from "@cemp/ui";
import { useAppContainer, type RootStackParamList } from "../navigation";

export function ContactsScreen(): React.JSX.Element {
  const container = useAppContainer();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [vm] = useState(() => new ContactListViewModel(container.repositories.contacts));
  const [items, setItems] = useState<readonly Contact[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const unsubscribe = vm.subscribe(() => {
      setItems(vm.items);
    });
    void vm.refresh();
    const unsubscribeFocus = navigation.addListener("focus", () => {
      void vm.refresh();
    });
    return () => {
      unsubscribe();
      unsubscribeFocus();
    };
  }, [vm, navigation]);

  return (
    <View style={styles.flex}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            void vm.setQuery(text);
          }}
          placeholder="Search contacts"
          autoCapitalize="none"
        />
        <Button title="Add" onPress={() => navigation.navigate("ContactEdit", {})} />
      </View>
      <FlatList
        data={items as Contact[]}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text>No contacts yet.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.rowBody}
              onPress={() => {
                // Message-first: opening a contact goes to the conversation
                // (created on demand, idempotent — Phase 6 repository).
                void container.repositories.conversations
                  .getOrCreateForContact(item.id)
                  .then((conversation) => {
                    navigation.navigate("Chat", {
                      conversationId: conversation.id,
                      title: item.displayName,
                    });
                  });
              }}
            >
              <Text style={styles.name}>{item.displayName}</Text>
              {item.notes !== "" ? <Text style={styles.notes}>{item.notes}</Text> : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.editButton}
              onPress={() => navigation.navigate("ContactEdit", { contactId: item.id })}
            >
              <Text style={styles.editButtonText}>EDIT</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  searchRow: { flexDirection: "row", padding: 8, gap: 8, alignItems: "center" },
  search: { flex: 1, borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 8 },
  empty: { padding: 32, alignItems: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ccc",
  },
  rowBody: { flex: 1 },
  editButton: { paddingHorizontal: 12, paddingVertical: 6 },
  editButtonText: { color: "#4a6fa5", fontWeight: "700", fontSize: 12 },
  name: { fontSize: 16, fontWeight: "600" },
  notes: { color: "#666", marginTop: 2 },
});
