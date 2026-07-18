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
import type { Contact, Message } from "@cemp/database";
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
  const [contact, setContact] = useState<Contact | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const conversation = await container.repositories.conversations.getById(conversationId);
      if (conversation === undefined) return;
      const c = await container.repositories.contacts.getById(conversation.contactId);
      if (!cancelled && c !== undefined) setContact(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function send(): Promise<void> {
    composer.setText(draft);
    setPublishError(null);
    try {
      const sent = await composer.send();
      if (sent === undefined) {
        if (composer.error === null) {
          console.error("ChatScreen.send: composer.send() returned undefined without an error");
        }
        return;
      }
      setDraft("");
      // P2P: publish to the contact's on-chain profile when we can (the row
      // stays queued locally and the workers retry otherwise).
      if (container.hasMessaging && contact?.profileIdHex != null) {
        try {
          await container.messaging.publishMessage({
            messageRowId: sent.id,
            logicalMessageId: sent.logicalMessageId,
            text: sent.body ?? "",
            recipientProfileIdHex: contact.profileIdHex,
          });
        } catch (e) {
          setPublishError(
            e instanceof Error && "userMessage" in e
              ? String((e as { userMessage: unknown }).userMessage)
              : "Couldn't publish right now — the message is saved and will retry.",
          );
        }
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
      {publishError !== null ? <Text style={styles.errorText}>{publishError}</Text> : null}
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
