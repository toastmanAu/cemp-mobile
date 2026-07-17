/**
 * Conversation list view-model (spec Phase 6 task 7).
 *
 * Platform-neutral state holder for the conversation list screen: the React
 * Native screen subscribes, calls `refresh()` when it mounts and after any
 * sync, and renders `items`. All data comes from the conversation
 * repository's single-query list — this class adds selection + subscription,
 * no SQL.
 */

import type { ConversationListItem, ConversationRepository } from "@cemp/database";

export class ConversationListViewModel {
  readonly #conversations: ConversationRepository;
  readonly #listeners = new Set<() => void>();

  #items: ConversationListItem[] = [];
  #selectedId: number | null = null;
  #loading = false;

  constructor(conversations: ConversationRepository) {
    this.#conversations = conversations;
  }

  get items(): readonly ConversationListItem[] {
    return this.#items;
  }

  get selectedId(): number | null {
    return this.#selectedId;
  }

  get loading(): boolean {
    return this.#loading;
  }

  get selected(): ConversationListItem | undefined {
    return this.#items.find((item) => item.id === this.#selectedId);
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
    this.#loading = true;
    this.#notify();
    try {
      this.#items = await this.#conversations.listWithPreview();
      // Selection survives refreshes while the conversation still exists.
      if (this.#selectedId !== null && !this.#items.some((i) => i.id === this.#selectedId)) {
        this.#selectedId = null;
      }
    } finally {
      this.#loading = false;
      this.#notify();
    }
  }

  select(conversationId: number | null): void {
    if (this.#selectedId !== conversationId) {
      this.#selectedId = conversationId;
      this.#notify();
    }
  }
}
