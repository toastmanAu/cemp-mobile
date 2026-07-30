/**
 * My contact card: the device's contact bundle (spec §5.4) as a scannable QR,
 * plus a share sheet that forwards it as a PNG with a caption.
 *
 * The QR carries the bundle ONLY. The display name rides in the caption, so a
 * forwarded image never leaks a name the sender did not attach.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Button, Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { ContactBundleV1 } from "@cemp/core";
import { contactCardPng, encodeContactBundle } from "@cemp/core";
import { MY_DISPLAY_NAME_KEY } from "@cemp/database";
import { useAppContainer, type RootStackParamList } from "../navigation";
import { bytesToBase64 } from "../platform/base64";

export function MyCardScreen(): React.JSX.Element {
  const container = useAppContainer();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [bundle, setBundle] = useState<ContactBundleV1 | null>(null);
  const [pngBase64, setPngBase64] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [messagingUnavailable, setMessagingUnavailable] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [nameLoadError, setNameLoadError] = useState<string | null>(null);
  const [nameSaveError, setNameSaveError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The bundle load and the saved-name load fail for unrelated reasons —
      // conflating them in one try/catch is the same shape that turned a
      // correct vault password into an hours-long false negative on the
      // unlock screen (see unlock-screen.tsx's `attempt`). A settings-read
      // failure here must not tell a user with a published profile to go
      // publish one, so each gets its own try/catch and its own message, and
      // a failure in one must not skip the other.
      const messagingReady = container.hasMessaging;
      if (!cancelled) setMessagingUnavailable(!messagingReady);

      if (messagingReady) {
        try {
          const mine = await container.messaging.myContactBundle();
          if (!cancelled) {
            setBundle(mine);
            setPngBase64(mine === null ? null : bytesToBase64(contactCardPng(mine)));
          }
        } catch {
          if (!cancelled) setBundleError("Could not build your contact card. Try again shortly.");
        }
      }

      try {
        const name = await container.repositories.localSettings.get(MY_DISPLAY_NAME_KEY);
        if (!cancelled) setDisplayName(name ?? "");
      } catch {
        // Non-blocking: an empty name field is perfectly usable, and the user
        // can still type one before sharing.
        if (!cancelled) setNameLoadError("Could not load your saved display name.");
      }

      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [container]);

  const share = useCallback(async () => {
    if (bundle === null || sharing) return;
    setSharing(true);
    setNameSaveError(null);
    setShareError(null);
    // Saving the name and presenting the share sheet fail for unrelated
    // reasons too (same rationale as the load above). A failed save must not
    // cancel the share: the caption below is built from the name the user
    // just typed, so the shared card is correct regardless of whether the
    // preference persisted for next time — only surface a non-blocking
    // warning and continue.
    try {
      await container.repositories.localSettings.set(MY_DISPLAY_NAME_KEY, displayName);
    } catch {
      setNameSaveError("Your name could not be saved, but the card will still share with it.");
    }
    try {
      const trimmed = displayName.trim();
      const caption =
        trimmed.length > 0
          ? `Add ${trimmed} on CellSend:\n\n${encodeContactBundle(bundle)}`
          : `Add me on CellSend:\n\n${encodeContactBundle(bundle)}`;
      await container.shareContactCard(contactCardPng(bundle), caption);
    } catch {
      setShareError("Could not open the share sheet.");
    } finally {
      setSharing(false);
    }
  }, [bundle, container, displayName, sharing]);

  if (loading) {
    return (
      <View style={styles.container}>
        <Text>Building your card…</Text>
      </View>
    );
  }

  if (messagingUnavailable) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Messaging isn't running</Text>
        <Text>
          The messaging system didn't start on this device, so your contact card can't be built
          right now. Try closing and reopening the app.
        </Text>
      </View>
    );
  }

  if (bundleError !== null) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.error}>{bundleError}</Text>
      </View>
    );
  }

  if (bundle === null) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>No contact card yet</Text>
        <Text>
          Your card is built from your on-chain profile. Publish your profile in Settings first,
          then come back here.
        </Text>
        <Button
          title="Go to Settings"
          onPress={() => navigation.navigate("Main", { screen: "Settings" })}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>My contact card</Text>
      <Text>Have them scan this, or share it to send it on.</Text>
      {pngBase64 !== null ? (
        <Image
          style={styles.qr}
          resizeMode="contain"
          source={{ uri: `data:image/png;base64,${pngBase64}` }}
        />
      ) : null}
      <Text style={styles.label}>Name shown when you share</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="your name"
        autoCapitalize="words"
      />
      {nameLoadError !== null ? <Text style={styles.error}>{nameLoadError}</Text> : null}
      <Text style={styles.fingerprint}>{bundle.fingerprint}</Text>
      <Text style={styles.hint}>
        Read this fingerprint aloud to confirm you added the right person.
      </Text>
      <Button title="Share my card" disabled={sharing} onPress={() => void share()} />
      {nameSaveError !== null ? <Text style={styles.error}>{nameSaveError}</Text> : null}
      {shareError !== null ? <Text style={styles.error}>{shareError}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "600" },
  qr: { width: "100%", aspectRatio: 1, backgroundColor: "#fff" },
  label: { fontSize: 14, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  fingerprint: { fontFamily: "monospace", fontSize: 14, textAlign: "center" },
  hint: { fontSize: 12, color: "#555", textAlign: "center" },
  error: { color: "#b00020" },
});
