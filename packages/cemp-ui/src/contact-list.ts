/**
 * Contact list + contact edit view-models (spec Phase 6 tasks 8–9).
 *
 * Validation limits live here (not the repository) because they are UI
 * constraints: the repository stores what it is given; the shell decides what
 * a user may enter. Avatar bytes round-trip through the encrypted database
 * only — never through any file or network path (Phase 6 exit criterion).
 */

import type { Contact, ContactRepository } from "@cemp/database";

/** UI constraints for the contact edit screen. */
export const CONTACT_EDIT_LIMITS = {
  maxDisplayNameChars: 64,
  maxNotesChars: 2048,
  maxAvatarBytes: 262_144,
} as const;

export class ContactListViewModel {
  readonly #contacts: ContactRepository;
  readonly #listeners = new Set<() => void>();

  #items: Contact[] = [];
  #query = "";

  constructor(contacts: ContactRepository) {
    this.#contacts = contacts;
  }

  get items(): readonly Contact[] {
    return this.#items;
  }

  get query(): string {
    return this.#query;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  async refresh(): Promise<void> {
    this.#items =
      this.#query === "" ? await this.#contacts.list() : await this.#contacts.search(this.#query);
    this.#notify();
  }

  async setQuery(query: string): Promise<void> {
    this.#query = query;
    await this.refresh();
  }
}

export type ContactEditError =
  | { readonly field: "displayName"; readonly reason: "required" | "too-long" }
  | { readonly field: "notes"; readonly reason: "too-long" }
  | { readonly field: "avatar"; readonly reason: "too-large" };

/** The edit screen's form model: create new or edit an existing contact. */
export class ContactEditModel {
  readonly #contacts: ContactRepository;
  readonly #contactId: number | null;

  displayName = "";
  notes = "";
  avatar: Uint8Array | null = null;

  constructor(contacts: ContactRepository, existing?: Contact & { avatar?: Uint8Array | null }) {
    this.#contacts = contacts;
    this.#contactId = existing?.id ?? null;
    if (existing !== undefined) {
      this.displayName = existing.displayName;
      this.notes = existing.notes;
      this.avatar = existing.avatar ?? null;
    }
  }

  /** All validation problems, empty when the form is saveable. */
  validate(): ContactEditError[] {
    const errors: ContactEditError[] = [];
    const name = this.displayName.trim();
    if (name.length === 0) {
      errors.push({ field: "displayName", reason: "required" });
    } else if (name.length > CONTACT_EDIT_LIMITS.maxDisplayNameChars) {
      errors.push({ field: "displayName", reason: "too-long" });
    }
    if (this.notes.length > CONTACT_EDIT_LIMITS.maxNotesChars) {
      errors.push({ field: "notes", reason: "too-long" });
    }
    if (this.avatar !== null && this.avatar.length > CONTACT_EDIT_LIMITS.maxAvatarBytes) {
      errors.push({ field: "avatar", reason: "too-large" });
    }
    return errors;
  }

  /** Persist; throws the validation list when invalid. Returns the id. */
  async save(): Promise<number> {
    const errors = this.validate();
    if (errors.length > 0) {
      throw errors;
    }
    const displayName = this.displayName.trim();
    if (this.#contactId === null) {
      const created = await this.#contacts.create({ displayName, notes: this.notes });
      if (this.avatar !== null) {
        await this.#contacts.setAvatar(created.id, this.avatar);
      }
      return created.id;
    }
    await this.#contacts.update(this.#contactId, { displayName, notes: this.notes });
    await this.#contacts.setAvatar(this.#contactId, this.avatar);
    return this.#contactId;
  }
}
