/**
 * My contact card: the device's contact bundle (spec §5.4) as a scannable QR,
 * plus a share sheet that forwards it as a PNG with a caption.
 *
 * The QR carries the bundle ONLY. The display name rides in the caption, so a
 * forwarded image never leaks a name the sender did not attach.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Button, Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ContactBundleV1 } from "@cemp/core";
import { contactCardPng, encodeContactBundle } from "@cemp/core";
import { MY_DISPLAY_NAME_KEY } from "@cemp/database";
import { useAppContainer } from "../navigation";
import { bytesToBase64 } from "../platform/base64";

export function MyCardScreen(): React.JSX.Element {
  const container = useAppContainer();
  const [bundle, setBundle] = useState<ContactBundleV1 | null>(null);
  const [pngBase64, setPngBase64] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mine = container.hasMessaging ? await container.messaging.myContactBundle() : null;
        const name = (await container.repositories.localSettings.get(MY_DISPLAY_NAME_KEY)) ?? "";
        if (cancelled) return;
        setBundle(mine);
        setDisplayName(name);
        setPngBase64(mine === null ? null : bytesToBase64(contactCardPng(mine)));
      } catch {
        if (!cancelled) setError("Could not build your contact card.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [container]);

  const share = useCallback(async () => {
    if (bundle === null) return;
    setError(null);
    try {
      await container.repositories.localSettings.set(MY_DISPLAY_NAME_KEY, displayName);
      const caption =
        displayName.trim().length > 0
          ? `Add ${displayName.trim()} on CellSend:\n\n${encodeContactBundle(bundle)}`
          : `Add me on CellSend:\n\n${encodeContactBundle(bundle)}`;
      await container.shareContactCard(contactCardPng(bundle), caption);
    } catch {
      setError("Could not open the share sheet.");
    }
  }, [bundle, container, displayName]);

  if (loading) {
    return (
      <View style={styles.container}>
        <Text>Building your card…</Text>
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
        {error !== null ? <Text style={styles.error}>{error}</Text> : null}
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
      <Text style={styles.fingerprint}>{bundle.fingerprint}</Text>
      <Text style={styles.hint}>
        Read this fingerprint aloud to confirm you added the right person.
      </Text>
      <Button title="Share my card" onPress={() => void share()} />
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
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
