# ADR 0005: acknowledgement responses (Phase 8 wiring) — auto-ack on receive

- Status: Accepted (2026-07-19)
- Context:
  - The protocol acknowledges a message by publishing a **response** cell that
    carries a `0x01` receipt naming the original envelope message id (spec
    §7.3). On the sender side this advances the outgoing message
    `available_on_chain → downloaded_by_recipient ("delivered") → acknowledged
    ("read") → reclaim_queued` (`ResponseLifecycle.processAcknowledgements`).
  - Two defects left the read-receipt path dead on-device (found during live
    two-device testnet bring-up):
    1. **Nothing queued a response.** The app only ever published *fresh*
       outgoing messages; no code created a response row, so no receipt was
       ever emitted and every sent message was stuck at "sent".
    2. **`runResponseSender` could not have published one anyway.** It selected
       rows in state `response_queued` (an *incoming* state) and handed them to
       `MessagePublisher.publishText`, which walks its row through the
       *outgoing* state machine (`queued → encrypting → …`). The first
       transition throws `illegal-state-transition`, so the worker fails. The
       path had **zero end-to-end test coverage**, so this stayed invisible.
- Decision:
  - **A response is a normal outgoing message row**, not an `response_queued`
    row: `direction: "outgoing"`, initial state `queued`, `body: ""`
    (receipt-only), `logicalMessageId: "response:<originalIncomingLogicalId>"`,
    and a `reply_to` chain ref pointing at the original message cell's outpoint.
    `publishText` then drives it through the outgoing machine unchanged.
  - **`runResponseSender` selects `queued` outgoing rows whose logical id is
    prefixed `response:`** (idempotency + marker), publishes each with its
    `0x01` receipt, and advances the *original incoming* message
    `received → displayed → response_queued → response_sent` (that incoming
    lifecycle is unchanged and correct).
  - **Auto-ack on receive:** when incoming discovery ingests a *new content*
    message, it queues exactly one such response row (idempotent on the
    `response:` logical id). The ack body is empty; a future "reply" feature can
    reuse the same row with text.
  - **Receipt-only messages create no bubble and are never re-acked.** An
    incoming envelope with empty text and ≥1 receipt is a pure ack: its receipts
    are processed (advancing our outgoing messages) but it is not inserted as a
    chat row and does not trigger another ack. This terminates the ack exchange
    (acks carry no content, and only content messages are auto-acked).
  - **Response rows are hidden from the UI**: `listByConversation` and the
    conversation-list preview exclude `logical_message_id LIKE 'response:%'`.
- Consequences:
  - `sent → delivered → read` now advances end-to-end with no user action on the
    recipient side; verified live on two devices (Samsung ↔ Retroid, testnet).
  - Each received content message costs the recipient one small testnet tx (the
    ack cell), reclaimable like any message cell.
  - Honoring `receiptRequest: 0` (sender opts out of receipts) is not yet wired —
    the recipient auto-acks every content message. Tracked as a follow-up.
  - Background/interval delivery is still absent (discovery only runs on Chats
    focus); acks likewise flush on the next foreground sync. Phase 9 concern.
