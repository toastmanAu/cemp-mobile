/**
 * Conversation screen (spec §16.2): left/right message bubbles with state
 * presentation from {@link messageBubbleState}, plus the composer
 * ({@link ChatComposerViewModel}). No blockchain terminology (rule 15).
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Button,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Attachment, Contact, Message } from "@cemp/database";
import { codec } from "@cemp/core";
import {
  ChatComposerViewModel,
  imageBubbleState,
  messageBubbleState,
  type BubbleStatus,
  type ImageDownloadState,
} from "@cemp/ui";
import { pickImage } from "../platform/native-image-picker";
import { bytesToBase64 } from "../platform/base64";
import { useAppContainer, type RootStackParamList } from "../navigation";

/** In-memory record of a downloaded full-resolution image (never persisted). */
interface FullImage {
  readonly base64: string;
  readonly mimeType: string;
}

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
  // Keep the composer + byte-count clear of the Android system navigation bar
  // (gesture pill / 3-button bar). Insets come from the SafeAreaProviderCompat
  // that the native-stack navigator mounts above every screen.
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [composer] = useState(
    () => new ChatComposerViewModel(container.repositories.messages, conversationId),
  );
  const [draft, setDraft] = useState("");
  const [contact, setContact] = useState<Contact | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [attachmentsByMessage, setAttachmentsByMessage] = useState<Map<number, Attachment>>(
    new Map(),
  );
  const [downloadStates, setDownloadStates] = useState<Map<number, ImageDownloadState>>(new Map());
  const [fullImages, setFullImages] = useState<Map<number, FullImage>>(new Map());

  async function reload(): Promise<void> {
    const list = await container.repositories.messages.listByConversation(conversationId, {
      limit: 100,
    });
    setMessages(list);
    // One image attachment per message (spec: single attachment per message).
    const perMessage = await Promise.all(
      list.map(async (m) => {
        const found = await container.repositories.attachments.listForMessage(m.id);
        return [m.id, found.find((a) => a.kind === "image")] as const;
      }),
    );
    const nextAttachments = new Map<number, Attachment>();
    for (const [messageId, attachment] of perMessage) {
      if (attachment !== undefined) nextAttachments.set(messageId, attachment);
    }
    setAttachmentsByMessage(nextAttachments);
  }

  function setDownloadState(messageId: number, state: ImageDownloadState): void {
    setDownloadStates((prev) => {
      const next = new Map(prev);
      next.set(messageId, state);
      return next;
    });
  }

  /** Attach + send an image (spec §4 item 2/5A). Cancel is a silent no-op. */
  async function attachImage(): Promise<void> {
    setPublishError(null);
    try {
      const bytes = await pickImage();
      if (bytes === null) return; // cancel = no-op
      const row = await composer.insertImageDraft();
      if (container.hasMessaging && contact?.profileIdHex != null) {
        await container.messaging.publishImage({
          messageRowId: row.id,
          logicalMessageId: row.logicalMessageId,
          recipientProfileIdHex: contact.profileIdHex,
          sourceBytes: bytes,
        });
      }
    } catch (e) {
      // ImageTooLargeError / decode / capacity all arrive here already jargon-free.
      setPublishError(e instanceof Error ? e.message : "Couldn't send that image.");
    }
    await reload();
  }

  /** Tap-to-download an incoming image (7A: keep thumbnail, offer retry on failure). */
  async function loadFull(messageId: number, manifest: codec.AttachmentManifestV1): Promise<void> {
    setDownloadState(messageId, "loading");
    try {
      const full = await container.messaging.downloadImageAttachment(messageId, manifest);
      setFullImages((prev) => {
        const next = new Map(prev);
        next.set(messageId, { base64: bytesToBase64(full.bytes), mimeType: full.mimeType });
        return next;
      });
      setDownloadState(messageId, "loaded");
    } catch {
      setDownloadState(messageId, "error");
    }
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
      style={[styles.flex, { paddingBottom: insets.bottom }]}
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
          const attachment = attachmentsByMessage.get(item.id);
          if (attachment !== undefined && attachment.manifest !== null) {
            const manifest = codec.decodeAttachmentManifestV1(attachment.manifest);
            return (
              <ImageBubble
                outgoing={outgoing}
                manifest={manifest}
                downloadState={downloadStates.get(item.id) ?? "idle"}
                full={fullImages.get(item.id)}
                statusLabel={label}
                canRetry={bubble.canRetry}
                onTap={() => void loadFull(item.id, manifest)}
              />
            );
          }
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
        <Button title="📎" onPress={() => void attachImage()} />
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

interface ImageBubbleProps {
  readonly outgoing: boolean;
  readonly manifest: codec.AttachmentManifestV1;
  readonly downloadState: ImageDownloadState;
  readonly full: FullImage | undefined;
  readonly statusLabel: string;
  readonly canRetry: boolean;
  readonly onTap: () => void;
}

/**
 * Image message bubble: thumbnail (from the on-chain manifest) vs the
 * downloaded full image vs a spinner vs a 7A retry affordance, per
 * {@link imageBubbleState}. `data:` URIs are how RN's `<Image>` renders raw
 * bytes with no filesystem write.
 */
function ImageBubble({
  outgoing,
  manifest,
  downloadState,
  full,
  statusLabel,
  canRetry,
  onTap,
}: ImageBubbleProps): React.JSX.Element {
  const presentation = imageBubbleState({
    hasThumbnail: manifest.thumbnail != null,
    download: downloadState,
  });
  const declaredMimeType = new TextDecoder().decode(manifest.mime_type);
  const thumbnailUri =
    manifest.thumbnail != null
      ? `data:${declaredMimeType};base64,${bytesToBase64(manifest.thumbnail)}`
      : null;
  const fullUri = full !== undefined ? `data:${full.mimeType};base64,${full.base64}` : null;

  return (
    <View style={[styles.bubble, styles.imageBubble, outgoing ? styles.bubbleOut : styles.bubbleIn]}>
      <Pressable
        onPress={onTap}
        disabled={presentation.affordance === "none"}
        style={styles.imagePressable}
      >
        {presentation.showFull && fullUri !== null ? (
          <Image source={{ uri: fullUri }} style={styles.fullImage} resizeMode="contain" />
        ) : presentation.showThumbnail && thumbnailUri !== null ? (
          <Image source={{ uri: thumbnailUri }} style={styles.thumbnail} resizeMode="cover" />
        ) : (
          <View style={styles.thumbnailPlaceholder} />
        )}
        {presentation.showSpinner ? (
          <View style={styles.spinnerOverlay}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}
        {presentation.affordance === "tap-to-load" ? (
          <Text style={styles.imageAffordance}>Tap to load</Text>
        ) : null}
        {presentation.affordance === "tap-to-retry" ? (
          <Text style={[styles.imageAffordance, styles.statusRetry]}>Tap to retry</Text>
        ) : null}
      </Pressable>
      {statusLabel !== "" ? (
        <Text style={[styles.status, canRetry ? styles.statusRetry : null]}>{statusLabel}</Text>
      ) : null}
    </View>
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
  imageBubble: { padding: 4 },
  imagePressable: { width: 200, height: 200, borderRadius: 10, overflow: "hidden" },
  thumbnail: { width: "100%", height: "100%" },
  fullImage: { width: "100%", height: "100%" },
  thumbnailPlaceholder: { width: "100%", height: "100%", backgroundColor: "#c9c9c9" },
  spinnerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  imageAffordance: {
    position: "absolute",
    bottom: 6,
    left: 6,
    right: 6,
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 3,
  },
});
