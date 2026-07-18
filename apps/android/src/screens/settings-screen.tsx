/**
 * Settings tab (spec §16.5 + Phase 3 tasks 7–11): biometric toggle, the
 * password-gated mnemonic reveal, lock-now, and the double-confirmed wallet
 * wipe. Auto-lock interval display comes from the vault metadata.
 */

import React, { useEffect, useState } from "react";
import { Alert, Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAppContainer } from "../navigation";

export function SettingsScreen(): React.JSX.Element {
  const container = useAppContainer();
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [autoLockSeconds, setAutoLockSeconds] = useState<number | null>(null);
  const [revealPassword, setRevealPassword] = useState("");
  const [revealedWords, setRevealedWords] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);

  useEffect(() => {
    void container.vault.getMetadata().then((meta) => {
      setBiometricEnabled(meta.biometricEnabled);
      setAutoLockSeconds(meta.autoLockSeconds);
    });
  }, []);

  useEffect(() => {
    if (!container.hasMessaging) return;
    void container.messaging.myProfileId().then(setProfileId);
    void container.messaging.myFingerprint().then(setFingerprint);
  }, [container.hasMessaging]);

  async function publishProfile(): Promise<void> {
    if (!container.hasMessaging) return;
    setPublishing(true);
    setPublishMessage(null);
    setError(null);
    try {
      const result = await container.messaging.publishMyProfile(
        handle.trim().length > 0 ? handle.trim() : "me",
      );
      setProfileId(result.profileId);
      setFingerprint(await container.messaging.myFingerprint());
      setPublishMessage("Profile published. Share the profile id with your contacts.");
    } catch (e) {
      setPublishMessage(
        e instanceof Error
          ? `Couldn't publish: ${e.message}. The wallet needs testnet CKB first (see the Wallet tab).`
          : "Couldn't publish right now.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function toggleBiometrics(): Promise<void> {
    setError(null);
    try {
      if (biometricEnabled) {
        await container.vault.disableBiometrics();
        setBiometricEnabled(false);
      } else {
        await container.vault.enableBiometrics();
        setBiometricEnabled(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "biometric change failed");
    }
  }

  async function reveal(): Promise<void> {
    setError(null);
    try {
      const reveal = await container.vault.revealMnemonic(revealPassword);
      setRevealedWords(reveal.words);
      setRevealPassword("");
    } catch {
      setError("Wrong password.");
    }
  }

  function confirmWipe(): void {
    Alert.alert(
      "Wipe this wallet?",
      "This deletes the vault, the encrypted database keys and all local history on this device. Without your written recovery phrase the wallet is UNRECOVERABLE.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Wipe everything",
          style: "destructive",
          onPress: () => {
            void container.wipe();
          },
        },
      ],
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.section}>Security</Text>
      <View style={styles.row}>
        <Text>Biometric unlock</Text>
        <Button
          title={biometricEnabled ? "Disable" : "Enable"}
          onPress={() => void toggleBiometrics()}
        />
      </View>
      {autoLockSeconds !== null ? (
        <Text style={styles.muted}>
          Locks automatically after {Math.round(autoLockSeconds / 60)} min of inactivity.
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text>Lock now</Text>
        <Button title="Lock" onPress={() => void container.lock()} />
      </View>

      <Text style={styles.section}>Recovery phrase</Text>
      <Text style={styles.muted}>Enter the vault password to show the recovery phrase.</Text>
      <TextInput
        style={styles.input}
        secureTextEntry
        value={revealPassword}
        onChangeText={setRevealPassword}
        placeholder="vault password"
        autoComplete="off"
      />
      <Button
        title="Reveal phrase"
        disabled={revealPassword.length === 0}
        onPress={() => void reveal()}
      />
      {revealedWords !== null ? (
        <View style={styles.phraseBox}>
          <Text style={styles.phrase}>{revealedWords.join(" ")}</Text>
          <Button title="Hide" onPress={() => setRevealedWords(null)} />
        </View>
      ) : null}

      <Text style={styles.section}>Messaging profile</Text>
      {profileId !== null ? (
        <View style={styles.profileBox}>
          <Text style={styles.mono} selectable>
            Profile id: {profileId}
          </Text>
          {fingerprint !== null ? (
            <Text style={styles.mono} selectable>
              Fingerprint: {fingerprint}
            </Text>
          ) : null}
        </View>
      ) : (
        <>
          <Text style={styles.muted}>
            Publishing your profile puts your public keys on-chain so contacts can find and message
            you. It needs a funded wallet (see the Wallet tab).
          </Text>
          <TextInput
            style={styles.input}
            value={handle}
            onChangeText={setHandle}
            placeholder="handle (public, e.g. phill)"
            autoCapitalize="none"
            autoComplete="off"
          />
          <Button
            title={publishing ? "Publishing…" : "Publish my profile"}
            disabled={publishing || !container.hasMessaging}
            onPress={() => void publishProfile()}
          />
        </>
      )}
      {publishMessage !== null ? <Text style={styles.muted}>{publishMessage}</Text> : null}

      <Text style={styles.section}>Network</Text>
      <Text style={styles.muted}>CKB testnet (this build never touches mainnet).</Text>

      <Text style={styles.section}>Danger zone</Text>
      <Button title="Wipe wallet" color="#b00020" onPress={confirmWipe} />
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  section: { fontSize: 16, fontWeight: "700", marginTop: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  muted: { color: "#666" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  phraseBox: { borderWidth: 1, borderColor: "#333", borderRadius: 8, padding: 14, gap: 8 },
  phrase: { fontSize: 15, lineHeight: 22 },
  profileBox: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 12, gap: 6 },
  mono: { fontFamily: "monospace", fontSize: 12 },
  error: { color: "#b00020" },
});
