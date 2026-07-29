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
  const [armingReset, setArmingReset] = useState(false);
  /** The vault opened but its local database did not — offers the escape. */
  const [localDataBroken, setLocalDataBroken] = useState(false);
  const [armingLocalReset, setArmingLocalReset] = useState(false);

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

  /**
   * Unlocking is TWO steps that fail for unrelated reasons, and conflating
   * them is how a correct password got reported as wrong for hours on device
   * (2026-07-29): the vault opened fine, then the local database — encrypted
   * with a PREVIOUS wallet's key — failed its SQLCipher page-1 HMAC check,
   * and the single catch blamed the password. Attribute each step honestly.
   */
  async function attempt(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setLocalDataBroken(false);
    try {
      await action();
    } catch {
      // VaultError codes stay on the wire; the user sees one honest sentence.
      setError("Unlock failed — check the password and try again.");
      setBusy(false);
      return;
    }
    // Past this line the wallet IS open. Nothing that fails below is the
    // password's fault, and saying so sends the user round an unwinnable loop.
    try {
      await container.afterVaultUnlock();
    } catch {
      setError("Wallet unlocked, but this device's local data could not be opened.");
      setLocalDataBroken(true);
    } finally {
      setBusy(false);
    }
  }

  /** Delete the unreadable local database and finish opening the wallet. */
  async function resetLocalData(): Promise<void> {
    setBusy(true);
    try {
      await container.resetLocalData();
      await container.afterVaultUnlock();
      setError(null);
      setLocalDataBroken(false);
    } catch {
      setError("Could not reset local data on this device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>CellSend</Text>
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
      {localDataBroken ? (
        armingLocalReset ? (
          <>
            <Text style={styles.resetWarning}>
              This erases messages and contacts stored on this device. Your wallet and recovery
              phrase are NOT affected.
            </Text>
            <Button
              title="RESET LOCAL DATA"
              color="#b00020"
              disabled={busy}
              onPress={() => {
                setArmingLocalReset(false);
                void resetLocalData();
              }}
            />
            <Button title="Cancel" disabled={busy} onPress={() => setArmingLocalReset(false)} />
          </>
        ) : (
          <Button
            title="Reset local data (keeps your wallet)"
            disabled={busy}
            onPress={() => setArmingLocalReset(true)}
          />
        )
      ) : null}
      <View style={styles.resetArea} />
      {armingReset ? (
        <>
          <Text style={styles.resetWarning}>
            Resetting permanently erases the wallet on this device. If you don't have the recovery
            phrase written down, it cannot be recovered.
          </Text>
          <Button
            title="RESET WALLET"
            color="#b00020"
            disabled={busy}
            onPress={() =>
              void (async () => {
                setBusy(true);
                try {
                  await container.wipe();
                } catch {
                  // Never silent: a wipe that half-failed leaves state the
                  // next wallet trips over, and an unawaited rejection here
                  // is what hid the original database fault.
                  setError("Reset failed — the wallet on this device was not fully erased.");
                } finally {
                  setBusy(false);
                  setArmingReset(false);
                }
              })()
            }
          />
          <Button title="Cancel" disabled={busy} onPress={() => setArmingReset(false)} />
        </>
      ) : (
        <Button
          title="Forgot password? Reset wallet"
          disabled={busy}
          onPress={() => setArmingReset(true)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", textAlign: "center", marginBottom: 16 },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  spacer: { height: 8 },
  error: { color: "#b00020", textAlign: "center" },
  resetArea: { height: 24 },
  resetWarning: { color: "#b00020", textAlign: "center", fontSize: 12 },
});
