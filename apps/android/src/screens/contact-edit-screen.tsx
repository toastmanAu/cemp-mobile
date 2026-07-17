/**
 * Contact edit screen (spec Phase 6 task 9): validated form over
 * {@link ContactEditModel}; the profile link is shown read-only when the
 * contact has one (QR bundle scanning lands with Phase 5).
 */

import React, { useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ContactEditModel, type ContactEditError } from "@cemp/ui";
import { useAppContainer, type RootStackParamList } from "../navigation";

type Props = NativeStackScreenProps<RootStackParamList, "ContactEdit">;

function describeError(error: ContactEditError): string {
  if (error.field === "displayName") {
    return error.reason === "required"
      ? "A display name is required."
      : "The display name is too long.";
  }
  if (error.field === "notes") {
    return "The notes are too long.";
  }
  return "The avatar image is too large.";
}

export function ContactEditScreen({ route, navigation }: Props): React.JSX.Element {
  const container = useAppContainer();
  const [model, setModel] = useState<ContactEditModel | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<readonly ContactEditError[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);

  useEffect(() => {
    const contactId = route.params.contactId;
    if (contactId === undefined) {
      setModel(new ContactEditModel(container.repositories.contacts));
      return;
    }
    void container.repositories.contacts.getByIdWithAvatar(contactId).then((contact) => {
      if (contact === undefined) {
        navigation.goBack();
        return;
      }
      setModel(new ContactEditModel(container.repositories.contacts, contact));
      setDisplayName(contact.displayName);
      setNotes(contact.notes);
      setProfileId(contact.profileIdHex);
    });
  }, [route.params.contactId]);

  async function save(): Promise<void> {
    if (model === null) {
      return;
    }
    model.displayName = displayName;
    model.notes = notes;
    try {
      await model.save();
      navigation.goBack();
    } catch (e) {
      setErrors(e as ContactEditError[]);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        autoCapitalize="words"
      />
      <Text style={styles.label}>Notes (stored only on this device)</Text>
      <TextInput
        style={[styles.input, styles.notes]}
        value={notes}
        onChangeText={setNotes}
        multiline
      />
      {profileId !== null ? <Text style={styles.profile}>Linked profile: {profileId}</Text> : null}
      {errors.map((error) => (
        <Text key={error.field} style={styles.error}>
          {describeError(error)}
        </Text>
      ))}
      <Button title="Save" disabled={model === null} onPress={() => void save()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 10 },
  label: { fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10 },
  notes: { minHeight: 90, textAlignVertical: "top" },
  profile: { color: "#666", fontSize: 12 },
  error: { color: "#b00020" },
});
