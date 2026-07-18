/**
 * Conversation screen (spec §16.2): left/right message bubbles with state
 * presentation from {@link messageBubbleState}, plus the composer
 * ({@link ChatComposerViewModel}). No blockchain terminology (rule 15).
 */

import React, { useEffect, useState } from "react";
import {
  Button,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Message } from "@cemp/database";
import { ChatComposerViewModel, messageBubbleState, type BubbleStatus } from "@cemp/ui";
import { useAppContainer, type RootStackParamList } from "../navigation";

const STATUS_LABEL: Record<BubbleStatus, string> = {
  draft: "draft",
  sending: "sending…",
  sent: "sent",
  delivered: "delivered",
  acknowledged: "read",
  reclaimed: "capacity reclaimed",
  failed: "failed — tap retry",
  expired: "expired",
  receiving: "receiving…",
  received: "",
  invalid: "",
};

type Props = NativeStackScreenProps<RootStackParamList, "Chat">;

export function ChatScreen({ route }: Props): React.JSX.Element {
  const { conversationId } = route.params;
  const container = useAppContainer();
  const [messages, setMessages] = useState<Message[]>([]);
  const [composer] = useState(
    () => new ChatComposerViewModel(container.repositories.messages, conversationId),
  );
  const [draft, setDraft] = useState("");

  async function reload(): Promise<void> {
    setMessages(
      await container.repositories.messages.listByConversation(conversationId, { limit: 100 }),
    );
  }

  useEffect(() => {
    void reload();
    const interval = setInterval(() => {
      void reload();
    }, 3000);
    return () => {
      clearInterval(interval);
    };
  }, [conversationId]);

  async function send(): Promise<void> {
    composer.setText(draft);
    try {
      const sent = await composer.send();
      if (sent !== undefined) {
        setDraft("");
      } else if (composer.error === null) {
        // Early-return without an error message — surface it so silent
        // no-ops are impossible (device verification 2026-07-18).
        console.error("ChatScreen.send: composer.send() returned undefined without an error");
      }
    } catch (e) {
      console.error("ChatScreen.send threw:", e);
    }
    await reload();
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "android" ? undefined : "padding"}
    >
      <FlatList
        style={styles.flex}
        contentContainerStyle={styles.list}
        inverted
        data={messages}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => {
          const bubble = messageBubbleState(item);
          const outgoing = item.direction === "outgoing";
          const label = STATUS_LABEL[bubble.status];
          return (
            <View style={[styles.bubble, outgoing ? styles.bubbleOut : styles.bubbleIn]}>
              <Text style={outgoing ? styles.bubbleTextOut : styles.bubbleTextIn}>{item.body}</Text>
              {label !== "" ? (
                <Text style={[styles.status, bubble.canRetry ? styles.statusRetry : null]}>
                  {label}
                </Text>
              ) : null}
            </View>
          );
        }}
      />
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          multiline
        />
        <Button title="Send" disabled={draft.trim().length === 0} onPress={() => void send()} />
      </View>
      {composer.error !== null ? <Text style={styles.errorText}>{composer.error}</Text> : null}
      <Text style={styles.byteCount}>
        {composer.byteLength}/{composer.maxBytes} bytes
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: 12, gap: 8 },
  bubble: { maxWidth: "80%", borderRadius: 14, padding: 10 },
  bubbleOut: { alignSelf: "flex-end", backgroundColor: "#4a6fa5" },
  bubbleIn: { alignSelf: "flex-start", backgroundColor: "#e5e5ea" },
  bubbleTextOut: { color: "#fff" },
  bubbleTextIn: { color: "#111" },
  status: { fontSize: 10, color: "#d0d8e8", marginTop: 4 },
  statusRetry: { color: "#ffcccb", fontWeight: "700" },
  composer: { flexDirection: "row", alignItems: "flex-end", padding: 8, gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxHeight: 120,
  },
  byteCount: {
    fontSize: 10,
    color: "#999",
    textAlign: "right",
    paddingRight: 12,
    paddingBottom: 4,
  },
  errorText: { color: "#b00020", paddingHorizontal: 12, paddingBottom: 4 },
});
