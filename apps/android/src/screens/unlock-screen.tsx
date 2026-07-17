/**
 * Unlock screen (locked state): password unlock, plus biometric unlock when a
 * biometric wrap slot exists (spec Phase 3 tasks 6–7).
 */

import React, { useEffect, useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import { useAppContainer } from "../navigation";

export function UnlockScreen(): React.JSX.Element {
  const container = useAppContainer();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);

  useEffect(() => {
    container.vault
      .getMetadata()
      .then((meta) => {
        setBiometricEnabled(meta.biometricEnabled);
      })
      .catch(() => {
        // Metadata unavailable — password path still works.
      });
  }, [container]);

  async function attempt(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await container.afterVaultUnlock();
    } catch {
      // VaultError codes stay on the wire; the user sees one honest sentence.
      setError("Unlock failed — check the password and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>CEMP</Text>
      <TextInput
        style={styles.input}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        placeholder="vault password"
        autoComplete="off"
        onSubmitEditing={() => {
          if (password.length > 0 && !busy) {
            void attempt(async () => container.vault.unlock(password));
          }
        }}
      />
      <Button
        title="Unlock"
        disabled={password.length === 0 || busy}
        onPress={() => void attempt(async () => container.vault.unlock(password))}
      />
      {biometricEnabled ? (
        <>
          <View style={styles.spacer} />
          <Button
            title="Unlock with biometrics"
            disabled={busy}
            onPress={() => void attempt(async () => container.vault.unlockWithBiometrics())}
          />
        </>
      ) : null}
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: 16 },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  spacer: { height: 8 },
  error: { color: "#b00020", textAlign: "center" },
});
