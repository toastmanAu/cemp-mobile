/**
 * Scan-contact screen (spec Phase 6 / slice 2): add a contact from a scanned
 * CellSend card, by camera, by picking a photo, or by pasting the wire text.
 *
 * All three inputs converge on {@link handleScanned}, a deliberate two-pass
 * handler: `classifyScannedCard` (Task 1, `@cemp/core`) is synchronous and
 * fully unit-tested, so pass 1 classifies with a `findExisting` that always
 * returns `undefined` — self and unreadable are fully decided from that alone.
 * Only an `addable` outcome needs the database consulted, so pass 2 looks it
 * up and downgrades to `duplicate` here, in the screen, keeping I/O out of the
 * tested core.
 *
 * Three semantically distinct failures get three separate try/catch blocks
 * and three separate messages — scanning, classifying, and saving fail for
 * unrelated reasons, and conflating them is the same shape that turned a
 * correct vault password into an hours-long false negative on the unlock
 * screen (see unlock-screen.tsx's `attempt`).
 */

import React, { useCallback, useRef, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { classifyScannedCard, normalizeProfileId, type ScanOutcome } from "@cemp/core";
import { useAppContainer, type RootStackParamList } from "../navigation";

function unreadableMessage(outcome: ScanOutcome & { kind: "unreadable" }): string {
  switch (outcome.reason) {
    case "not-a-card":
      return "That doesn't look like a CellSend contact card.";
    case "unsupported-version":
      return "This card was made by a newer version of CellSend. Update the app and try again.";
    case "wrong-network":
      return "This card is for a different network and can't be added here.";
    case "damaged":
      return "This code looks damaged and couldn't be read.";
  }
}

export function ScanContactScreen(): React.JSX.Element {
  const container = useAppContainer();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const mountedRef = useRef(true);
  React.useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const [result, setResult] = useState<ScanOutcome | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  const [scanError, setScanError] = useState<string | null>(null);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Pass 1: pure classification (self / unreadable fully decided here).
   * Pass 2: only an addable card needs the database consulted, then
   * downgraded to duplicate here if a matching contact already exists.
   *
   * Never throws by construction EXCEPT for the pass-2 repository lookup,
   * which is real I/O — the caller wraps this call in its own try/catch so a
   * lookup failure is reported distinctly from a scan failure.
   */
  const handleScanned = useCallback(
    async (text: string | null): Promise<void> => {
      if (text === null) {
        // Cancel — a dismissed camera, no photo chosen, or an image with no
        // code in it — is a normal outcome, not an error.
        return;
      }
      const myProfileIdHex = container.hasMessaging
        ? await container.messaging.myProfileId()
        : null;

      const outcome = classifyScannedCard({
        text,
        myProfileIdHex,
        findExisting: () => undefined,
      });

      if (outcome.kind === "addable") {
        const existing = await container.repositories.contacts.getByProfileId(
          normalizeProfileId(outcome.bundle.profileTypeId),
        );
        if (existing !== undefined) {
          if (mountedRef.current) {
            setResult({
              kind: "duplicate",
              bundle: outcome.bundle,
              existingContactId: existing.id,
            });
          }
          return;
        }
      }
      if (mountedRef.current) setResult(outcome);
    },
    [container],
  );

  const runCameraScan = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setScanError(null);
    setClassifyError(null);
    let text: string | null;
    try {
      text = await container.scanContactWithCamera();
    } catch {
      if (mountedRef.current) setScanError("Could not open the camera scanner.");
      if (mountedRef.current) setBusy(false);
      return;
    }
    try {
      await handleScanned(text);
    } catch {
      if (mountedRef.current) {
        setClassifyError("Could not check the scanned code against your contacts.");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, container, handleScanned]);

  const runPhotoScan = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setScanError(null);
    setClassifyError(null);
    let text: string | null;
    try {
      text = await container.scanContactFromPhoto();
    } catch {
      if (mountedRef.current) setScanError("Could not read a code from that photo.");
      if (mountedRef.current) setBusy(false);
      return;
    }
    try {
      await handleScanned(text);
    } catch {
      if (mountedRef.current) {
        setClassifyError("Could not check the scanned code against your contacts.");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, container, handleScanned]);

  const runPasteScan = useCallback(async (): Promise<void> => {
    if (busy || pasteText.trim().length === 0) return;
    setBusy(true);
    setScanError(null);
    setClassifyError(null);
    try {
      await handleScanned(pasteText);
    } catch {
      if (mountedRef.current) {
        setClassifyError("Could not check the pasted code against your contacts.");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, pasteText, handleScanned]);

  const save = useCallback(async (): Promise<void> => {
    if (result === null || result.kind !== "addable" || busy) return;
    const trimmed = displayName.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setSaveError(null);
    try {
      await container.repositories.contacts.create({
        displayName: trimmed,
        profileIdHex: normalizeProfileId(result.bundle.profileTypeId),
      });
      navigation.goBack();
    } catch {
      if (mountedRef.current) setSaveError("Could not save this contact. Try again.");
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, container, displayName, navigation, result]);

  if (result !== null && result.kind === "addable") {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Add contact</Text>
        <Text style={styles.fingerprint}>{result.bundle.fingerprint}</Text>
        <Text style={styles.hint}>Network: {result.bundle.network}</Text>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="their name"
          autoCapitalize="words"
        />
        <Button
          title="Save"
          disabled={busy || displayName.trim().length === 0}
          onPress={() => void save()}
        />
        {saveError !== null ? <Text style={styles.error}>{saveError}</Text> : null}
      </ScrollView>
    );
  }

  if (result !== null && result.kind === "self") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>That's your own card</Text>
        <Text style={styles.fingerprint}>{result.bundle.fingerprint}</Text>
        <Text style={styles.hint}>Network: {result.bundle.network}</Text>
        <Text>Scan a card from someone else's device to add them as a contact.</Text>
      </View>
    );
  }

  if (result !== null && result.kind === "duplicate") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Already a contact</Text>
        <Text>You've already added this person.</Text>
        <Button
          title="View contact"
          onPress={() =>
            navigation.navigate("ContactEdit", { contactId: result.existingContactId })
          }
        />
      </View>
    );
  }

  if (result !== null && result.kind === "unreadable") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Couldn't read that code</Text>
        <Text style={styles.error}>{unreadableMessage(result)}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Add contact by QR code</Text>
      <Button title="Scan with camera" disabled={busy} onPress={() => void runCameraScan()} />
      <Button title="Scan from photo" disabled={busy} onPress={() => void runPhotoScan()} />
      <Text style={styles.label}>Or paste a code</Text>
      <TextInput
        style={styles.input}
        value={pasteText}
        onChangeText={setPasteText}
        placeholder="pasted CellSend card text"
        autoCapitalize="none"
        multiline
      />
      <Button
        title="Use pasted code"
        disabled={busy || pasteText.trim().length === 0}
        onPress={() => void runPasteScan()}
      />
      {scanError !== null ? <Text style={styles.error}>{scanError}</Text> : null}
      {classifyError !== null ? <Text style={styles.error}>{classifyError}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24, gap: 12, justifyContent: "center" },
  title: { fontSize: 22, fontWeight: "600" },
  label: { fontSize: 14, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  fingerprint: { fontFamily: "monospace", fontSize: 14, textAlign: "center" },
  hint: { fontSize: 12, color: "#555", textAlign: "center" },
  error: { color: "#b00020" },
});
