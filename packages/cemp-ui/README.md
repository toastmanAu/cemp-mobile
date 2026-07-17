# @cemp/ui

Messenger shell for CEMP Mobile (spec §16, Phase 6 tasks 7–12). Currently the
**platform-neutral view-model layer**: plain TypeScript classes and pure
functions with no React Native imports, fully testable against real SQL
through `@cemp/database/node`. The Android screens (React Native) land with
the app bootstrap and bind one-to-one to these view-models; this package MAY
use React Native primitives once screens exist (AGENTS.md — the other shared
packages must not).

## View-models

| Module                 | Phase 6 task                   | What the screen binds to                                                   |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `conversation-list.ts` | 7 conversation list            | `items` (preview + unread, activity-ordered), `select`, `subscribe`        |
| `contact-list.ts`      | 8 contact list, 9 contact edit | `ContactListViewModel` (list/search) + `ContactEditModel` (validated form) |
| `composer.ts`          | 10 chat composer               | `text`/`canSend`/`send()`; byte-accurate protocol cap; draft resume        |
| `bubble.ts`            | 11 message bubble states       | `messageBubbleState(message)` → status/spinner/retry                       |
| `notifier.ts`          | 12 notification channels       | `Notifier` interface + `NOTIFICATION_CHANNELS` (Android channel mapping)   |

Design rules baked in:

- **No blockchain terminology at the chat surface** (AGENTS.md rule 15):
  bubbles show `sending → sent → delivered → acknowledged`, never "committed"
  or "outpoint". Chain states map to presentation in `bubble.ts` only.
- **Idempotent sends** (rule 5): the composer generates a random 128-bit
  `logical_message_id`; the message repository's UNIQUE constraint makes
  retries collapse to one row.
- **Protocol caps at the UI edge**: the composer measures UTF-8 **bytes**
  against `codec.V1_LIMITS.maxTextBytes` (16,384), not characters.
- **Subscription pattern**: each view-model exposes
  `subscribe(listener): unsubscribe`; screens re-render on notify.

## Android binding notes (for the bootstrap card)

- Create the two notification channels from `NOTIFICATION_CHANNELS` at app
  start (`messages` = high importance, `sync-status` = low), then implement
  `Notifier` over `Notifee` or the native `NotificationManager`.
- `NoopNotifier` is the headless/test implementation.
- Contact avatars flow: image picker → bytes → `ContactEditModel.avatar` →
  `ContactRepository.setAvatar` (bytes stay inside the encrypted database;
  Phase 6 exit criterion). No file/cache copies.
