# CKB-LoRa Transport for CEMP Mobile — Implementation Plan

**Status:** L1–L4 implemented (2026-09-26); L5 (hardware round-trip) outstanding
**Author:** Kernel 🐧 (for Phill / Wyltek)
**Created:** 2026-09-26
**Repo:** `github.com/toastmanAu/cemp-mobile` (`~/common-knowledge-direct`)
**Related:** `docs/protocol/CEMP-PROTOCOL-V1.md`, `ckd.txt`, `AGENTS.md`,
`~/ckb-lora-gateway` (device + gateway side of the radio link)

---

## 1. Goal

Add **LoRa radio** as a second, optional transport for CEMP messages, alongside
the existing CKB-chain cell transport. A message originating from a LilyGO
T-Deck (or another LoRa device) is relayed by the `sensecap-gw` CKB-LoRa
gateway into this app, decrypted, and filed into the **same** conversation
store as chain-delivered messages.

Non-goals (this phase):

- Mainnet. Testnet-only by construction (AGENTS.md rule 11).
- Replacing the chain transport. LoRa is additive and **off by default**.
- Native BLE/USB between phone and deck (that is the deck↔gateway RF link's job).

---

## 2. Where the work fits

The device→gateway leg is **already working** (verified 2026-09-26):

```
T-Deck  --LoRa 916.8 MHz SF7-->  sensecap-gw  --reassembled CEMP object-->
        (cemp_stream P6 reliable stream, CRC-checked)   gateway `OBJECT COMPLETE … crc=OK`
```

What is missing is the last hop: **gateway → this Android app**.

The app's inbound pipeline is already transport-agnostic. Anything that can
produce the raw **`cellData`** envelope bytes can reuse the whole chain:

```
raw envelope bytes ──► processIncomingText({cellData, ownKemSecretKey, ownProfileId})
                          packages/cemp-ckb/src/incoming.ts
    → IncomingTextMessage → (block check → ack handling → rate limit →
      contact resolve → conversation → messages.insert)
      packages/cemp-sync/src/workers.ts : processDiscoveredCell()
```

> **Key insight:** the LoRa gateway's reassembled object **is** `cellData`.
> No new protocol code is required — only a new _source_ that feeds bytes into
> the existing `processDiscoveredCell` pipeline.

---

## 3. Architecture

```
┌─────────┐  LoRa   ┌────────────┐   HTTP/MQTT   ┌──────────────────────┐
│ T-Deck  │ ──────► │ sensecap-gw│ ────────────► │  cemp-mobile (RN)    │
│ cemp_stream       │  gateway   │  raw bytes    │  LoraTransport       │
└─────────┘         └────────────┘  + metadata   │   │                  │
                                                 │   ▼                  │
                                                 │ processDiscoveredCell│
                                                 │   │  (reused as-is)  │
                                                 │   ▼                  │
                                                 │ ConversationRepository│
                                                 └──────────────────────┘
```

**Two integration points on the gateway:**

1. **Expose** the reassembled object. The gateway already has it in
   `StreamReceiver.completed` (`projects/ckb-lora/gateway/cemp_stream_rx.py`).
   Publish it on a durable queue/topic and/or a local HTTP endpoint.
2. **Route tag** the object so the app knows which of _its_ inboxes it belongs
   to (the app keys inboxes by **route tag**, not profile id — see §5).

**One integration point in the app:**

3. A `LoraTransport` source that pulls from (1) and feeds (2) into the existing
   `processDiscoveredCell()` pipeline.

---

## 4. Decisions to make first

| #   | Decision                | Options                                                         | Recommendation                                                                               |
| --- | ----------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1  | Gateway→app channel     | local HTTP poll / MQTT subscribe / both                         | **HTTP poll first** (no broker dep on the phone, rule 10); add MQTT later if latency matters |
| D2  | Endpoint shape          | `GET /cemp/object?route=<tag>` (raw bytes + crc) / push webhook | `GET` poll with `?since=` cursor; idempotent by message id                                   |
| D3  | Transport enablement    | always on / settings toggle / build flag                        | **Settings toggle, default OFF** (rule 10: never a protocol dependency)                      |
| D4  | Cursor/liveness         | reuse `endpoint-rotation` cursor pattern / new cursor           | New cursor `lora-transport-cursor` (reuse `SyncCursorRepository`)                            |
| D5  | Where the adapter lives | `packages/cemp-lora` / inside `apps/android/src`                | **New `packages/cemp-lora`** — platform-neutral (rule 14), testable in Node                  |
| D6  | Hostname/config         | hard-code / network config                                      | **`packages/cemp-core` network config** (AGENTS.md: never hard-code endpoints)               |

---

## 5. ⚠️ Critical: route tag, not profile id

From the CellSend memory (`project_cemp_mobile_cellsend.md`):

> _"The keystore caches **route tags**, never the profile id — a leaked profile
> id exposes the inbox tag for every epoch past and future; a route tag exposes
> only its own."_

Consequence for LoRa: the **gateway must not need the profile id**. The app
subscribes by its **route tag** (prev/current/next epoch). The gateway holds a
`route tag → pending objects` map only. This also satisfies rule 10 and the
"no gateway custody of keys/plaintext" gate from the CKB-LoRa handoff.

The deck, when it sends, must address the object to the recipient's current
route tag — already derivable via `deriveRouteTag` in `@cemp/core`.

---

## 6. Work breakdown

### Phase L1 — Gateway exposure — **DONE 2026-09-26** (deployed on `sensecap-gw`,
`phill@192.168.68.74:~/ckb-lora-bridge`)

- [x] `StreamReceiver` on completion: spool hook in `cemp_stream_rx.py` (backup
      `cemp_stream_rx.py.pre-l1spool`) writes `(route, bytes, crc32, received_at,
      message_id)` to a SQLite spool (`cemp_spool.py` / `cemp_spool.db`, WAL;
      dedup `INSERT OR IGNORE` on message id; retention prune newest 1000 /
      7 days). Hook is failure-isolated — a spool error can never stall the
      radio RX path.
- [x] `GET /cemp/objects?route=<tag>&since=<cursor>` →
      `{objects: [{id, bytes_hex, crc32, received_at}], cursor}` served by
      `cemp_http.py` (stdlib-only) on `0.0.0.0:8765`, systemd unit
      `cemp-lora-http.service` (enabled). Cursor = single shared zero-padded
      monotonic seq across all routes; 400/404/405 on bad input.
- [x] `GET /cemp/health` → `{"ok": true}`.
- [x] Idempotency: stable id = the envelope's 16-byte `message_id`, parsed from
      the Molecule header by a minimal defensive table reader (verified against
      the `cemp-v1-envelope.json` golden vectors).
- **Deployed mode: promiscuous LAN.** The `cemp_stream` OPEN frame carries only
  `(stream_id, object_type)` — no route tag — so rows are stored with
  `route = NULL`, which matches any `?route=` query. The app still verifies
  crc + envelope and drops what it cannot decrypt. The `route` column and
  exact-match filter are in place for when the deck firmware adds a 32-byte
  recipient route tag to the stream OPEN frame (§9.3).
- Verified end-to-end with the real `@cemp/lora` `LoraTransport` from this repo
  polling `http://192.168.68.74:8765` (health, poll, crc + `validateEnvelope`
  acceptance of a golden-vector envelope, `since=` cursor filtering).
  `ckb-lora-ckb-bridge.service` (the unit running `ckb_bridge.py`) restarted
  cleanly; radio RX unaffected.

### Phase L2 — `packages/cemp-lora` (new, platform-neutral) — **DONE 2026-09-26**

- [x] `LoraEndpointConfig` type in `packages/cemp-core` network config
      (`{ baseUrl: string | null }`, structurally separate from chain `endpoints`;
      `CKB_TESTNET.lora = { baseUrl: null }` — off by default).
- [x] `LoraTransport` class (`@cemp/lora`, zero external runtime deps):
  - `poll(sinceCursor)` → one `?route=<tag>[&since=<cursor>]` query per route
    tag, merged, deduped by envelope message id; verifies `crc32` (in-package
    table-driven zlib CRC-32) and runs `codec.validateEnvelope` on every entry.
  - Treats all responses as hostile (rule 4): malformed entries are dropped,
    never fail the poll; non-200 / network / malformed-body failures throw a
    typed `LoraTransportError` for the sync engine's worker backoff.
  - `health()` never throws → boolean; used by the settings "Test connection".
- [x] Unit tests: CRC check vectors (incl. `"123456789" → 0xCBF43926`),
      happy-path merge/dedup/cursor, hostile-entry drops, error typing, health.
      Envelope fixtures reuse `codec.buildEnvelope` / `encodeCempEnvelopeV1`
      (no new serialization — rule 1).

### Phase L3 — Wire into the sync engine (`apps/android` + `packages/cemp-sync`) — **DONE 2026-09-26**

- [x] Factored the persistence tail of `processDiscoveredCell()` into the
      exported `ingestIncomingCellData(deps, ownProfileId, cellDataHex, source)`
      in `packages/cemp-sync/src/workers.ts`, where
      `source: { txHash; outpointIndex } | null`. Chain discovery passes its
      outpoint (byte-identical behavior); the LoRa worker passes `null`.
- [x] New `"lora"` worker in `buildWorkerSpecs()` (30s nominal interval —
      WorkManager clamps it to the 15-minute floor in the background; the 30s
      cadence effectively applies via foreground catch-up, i.e. **foreground-only
      v1** as decided). Self-gating per tick: reads `lora.enabled` /
      `lora.gateway_url` from `LocalSettingsRepository`, falls back to
      `network.lora.baseUrl`, no-ops cleanly when disabled/unset or no profile is
      published yet. Subscribes by prev/current/next-epoch **route tags only**
      (§5). Poll failure → engine retry/backoff, cursor untouched.
- [x] Testability seam: optional `SyncWorkerDeps.createLoraTransport` factory
  - `LoraPollSource` interface; worker tests inject a fake poll source (no
    HTTP) while still ingesting real `assembleTextMessage`-derived cellData.

### Phase L4 — Settings + visibility — **DONE 2026-09-26**

- [x] Settings screen "LoRa relay" section: enable `Switch` (persists
      `lora.enabled`), gateway URL field (`lora.gateway_url`, saved on blur),
      "Test connection" button (constructs `LoraTransport` with **no route tags**
      and calls `health()` — reachability needs no keys and sends nothing
      identifying).
- [x] Rule 15 honored: plain copy only ("LoRa relay", "gateway address"); a
      LoRa-delivered message is indistinguishable in the chat UI — no badges.

### Phase L5 — Round-trip proof on hardware

- [ ] Deck → gateway → (driveThree app) → message appears in the right
      conversation, decrypted, no duplicates when polled twice.
- [ ] Kill/restart the app mid-poll → no duplicate chat rows (idempotency).
- [ ] Two objects same route → both land, in order.
- [ ] Hostile input: truncated bytes, bad crc, wrong route tag → dropped, no
      crash, no partial row.

---

## 6b. Decisions recorded during L2–L4 (2026-09-26)

- **No auto-ack for LoRa-ingested messages in v1.** The envelope auto-ack
  (ADR 0005) needs the original cell's outpoint to address its reply_to; a
  LoRa object has none. `ingestIncomingCellData` with `source: null` records
  no chain ref and queues no `response:` row — the message still decrypts,
  displays and notifies identically. Receipts over LoRa (a return path for
  the sender's delivered/read state) are future work. Note the reverse
  direction already works: a receipt-only envelope arriving VIA LoRa still
  advances our outgoing chain messages through `processAcknowledgements`.
- **Single merged cursor.** `LoraTransport.poll` queries each route tag
  separately and merges the per-query cursors as the lexicographic maximum —
  correct if the gateway's cursors are one shared, zero-padded monotonic
  sequence across all routes. If the gateway sequences each route tag
  independently, per-route cursors are needed instead (`lora-transport-cursor:<tag>`
  keys) — decide when the L1 gateway implementation lands.
- **Settings keys** `lora.enabled` (`"true"`/`"false"`) and `lora.gateway_url`
  in the `settings` table via `LocalSettingsRepository` (no migration); sync
  cursor name `lora-transport-cursor`. The settings URL overrides the
  network-config `lora.baseUrl` fallback (null on stock builds).
- **Foreground-only v1**: the worker's 30s interval is below the WorkManager
  floor, so backgrounded polling is clamped to 15 minutes and the real
  cadence comes from foreground catch-up (`runAllNow`). The locked-mode probe
  stays notify-only and untouched.
- **Worker gating**: `buildWorkerSpecs` always registers the `lora` spec; the
  run closure self-gates on the settings toggle per tick (specs are built
  once per unlock — a build-time gate would require an engine rebuild to
  flip the setting).

---

## 7. Acceptance criteria

- A CEMP envelope serialized on a T-Deck, relayed by `sensecap-gw`, appears in
  the correct cemp-mobile conversation, byte-identical to the same envelope
  delivered over the chain transport.
- Zero duplication across repeated polls (message-id dedup).
- LoRa transport disabled ⇒ zero behavioural change (byte-for-byte identical
  app behaviour to today).
- All new code platform-neutral; `packages/cemp-core` still runs in Node,
  Hermes, and future iOS (rule 14).
- No profile id ever leaves the device to the gateway (§5).
- `pnpm test` green; no changes to protocol serialization (rule 1).

---

## 8. Risks / gotchas

| Risk                                        | Mitigation                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Profile-id leak** (§5)                    | subscribe by route tag only; never send profile id to gateway                                                                      |
| Central-service dependency (rule 10)        | toggle off by default; chain path untouched                                                                                        |
| Duplicate rows                              | dedup on 16-byte message id (already the UNIQUE key)                                                                               |
| Rule 7 vs LoRa                              | LoRa has no chain commitment — never treat receipt as delivery; the _recipient_ app confirming is what advances our outgoing state |
| Radio input is hostile (rule 4)             | validate crc + parse before decrypt; malformed → recorded invalid, never stalls                                                    |
| Testnet/mainnet mix (rule 11)               | LoRa config is testnet-structural, separate from mainnet config                                                                    |
| Gateway offline                             | poll fails soft (BackoffPolicy), no user-visible error                                                                             |
| `processDiscoveredCell` assumes an outpoint | refactor to a source descriptor; audit downstream for outpoint deps                                                                |

---

## 9. Open questions for Phill

1. **D1/D2** — local HTTP poll OK to start, or do you want MQTT from day one?
2. **L3 background** — foreground-only for v1, or wire into the WorkManager tick?
3. **Deck addressing** — should the deck send to the recipient's _route tag_
   (current epoch), and how do we exchange that tag out-of-band (QR already
   exists for contacts — reuse the contact card)?
4. **Repo layout** — happy with a new `packages/cemp-lora` (platform-neutral) vs
   putting the adapter in `apps/android/src`?

---

## 10. References

- Device/gateway repo: `~/ckb-lora-gateway`, `~/ckb-lora-bridge` (on `sensecap-gw`)
- P6/P8 milestone + gotchas: `~/kernel-workspace/projects/ckb-lora/handoff/docs/10_PHASES.md`
- Receive seam: `packages/cemp-ckb/src/incoming.ts` → `processIncomingText`
- Sync call site: `packages/cemp-sync/src/workers.ts` → `processDiscoveredCell`
- Route/crypto: `@cemp/core` `deriveRouteTag`; `@cemp/crypto` `decryptEnvelope`
- Project memory: `~/.claude/projects/-home-phill/memory/project_cemp_mobile_cellsend.md`
