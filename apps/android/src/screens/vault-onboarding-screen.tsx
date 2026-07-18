/**
 * Vault onboarding (uninitialized state): create a new 12/24-word wallet or
 * import an existing BIP39 mnemonic (spec §5.1, Phase 3 tasks 1–2).
 *
 * Rule 2: the mnemonic the app shows here is displayed ONCE for the user to
 * write down; it is never logged, and the input fields clear on completion.
 */

import React, { useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAppContainer } from "../navigation";
import { MOBILE_VAULT_KDF } from "../platform/kdf";

export function VaultOnboardingScreen(): React.JSX.Element {
  const container = useAppContainer();
  const [password, setPassword] = useState("");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [createdWords, setCreatedWords] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const passwordOk = password.length >= 8;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (createdWords !== null) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Write down your recovery phrase</Text>
        <Text style={styles.warning}>
          These {createdWords.length} words are the ONLY way to recover this wallet. They are shown
          once and never stored in plain text.
        </Text>
        <View style={styles.phraseBox}>
          <Text style={styles.phrase}>{createdWords.join(" ")}</Text>
        </View>
        <Button
          title="I have written it down"
          onPress={() => {
            setCreatedWords(null);
            setPassword("");
            void container.afterVaultUnlock();
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Set up your CEMP wallet</Text>
      <Text>Choose a vault password (min. 8 characters). It protects this device only.</Text>
      <TextInput
        style={styles.input}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        placeholder="vault password"
        autoComplete="off"
      />
      <Button
        title="Create new wallet (12 words)"
        disabled={!passwordOk || busy}
        onPress={() =>
          void run(async () => {
            const reveal = await container.vault.createWithNewMnemonic(12, password, {
              kdf: MOBILE_VAULT_KDF,
            });
            setCreatedWords(reveal.words);
          })
        }
      />
      <View style={styles.spacer} />
      <Button
        title="Create new wallet (24 words)"
        disabled={!passwordOk || busy}
        onPress={() =>
          void run(async () => {
            const reveal = await container.vault.createWithNewMnemonic(24, password, {
              kdf: MOBILE_VAULT_KDF,
            });
            setCreatedWords(reveal.words);
          })
        }
      />
      <View style={styles.divider} />
      <Text style={styles.subtitle}>Or import an existing phrase</Text>
      <TextInput
        style={[styles.input, styles.mnemonicInput]}
        multiline
        value={mnemonicInput}
        onChangeText={setMnemonicInput}
        placeholder="twelve or twenty-four words, space separated"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />
      <Button
        title="Import wallet"
        disabled={!passwordOk || busy || mnemonicInput.trim().length === 0}
        onPress={() =>
          void run(async () => {
            const words = mnemonicInput.trim().toLowerCase().split(/\s+/);
            await container.vault.importMnemonic(words, password, undefined, {
              kdf: MOBILE_VAULT_KDF,
            });
            setMnemonicInput("");
            setPassword("");
            await container.afterVaultUnlock();
          })
        }
      />
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "600" },
  subtitle: { fontSize: 16, fontWeight: "500" },
  warning: { color: "#8a4b00" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  mnemonicInput: { minHeight: 80, textAlignVertical: "top" },
  phraseBox: { borderWidth: 1, borderColor: "#333", borderRadius: 8, padding: 16 },
  phrase: { fontSize: 16, lineHeight: 24 },
  spacer: { height: 4 },
  divider: { height: 1, backgroundColor: "#ccc", marginVertical: 16 },
  error: { color: "#b00020" },
});
