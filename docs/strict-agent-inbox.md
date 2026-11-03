# Strict agent inbox: per-bot subscriptions

A bot profile can be served only by Tower's addressed-only agent inbox (`agent_notifications.v1`) instead of the legacy workspace event feed. This page covers how Autopilot opts a profile in, how operators see each bot's real delivery path, and which session tools work afterwards.

The Tower contract is in Tower `docs/contract/agent-notifications-v1.md`.

## Delivery paths and status

`GET /api/agent-chat/bot-subscriptions` returns one row per real workspace and bot delivery path. Rows come from stored state only. Inbox cursors are never returned.

| Kind | Meaning |
|---|---|
| `profile` | A profile-bound subscription for one bot. |
| `shared` | A legacy subscription that serves several bots through the visibility audience. |
| `served_by_shared` | One bot that a shared subscription still serves. |

| Status | Meaning |
|---|---|
| `inbox` | Served only by the strict inbox, and the Tower inbox subscription is established. |
| `blocked` | The inbox halted, Tower lacks the capability, the key is missing, or Tower rejected the bot from the shared audience. The code is shown. |
| `legacy_profile` | A profile-bound subscription that still uses the legacy feed. |
| `legacy_shared` | The shared legacy subscription itself. |
| `not_migrated` | A bot served only through the shared legacy feed. |
| `disconnected` | The subscription is disabled, locally disconnected or revoked. |

Inbox mode does not mean Tower enforces isolation. Tower classification (notification-only) is read separately, with the bot's own signed request:

```
GET /api/agent-chat/subscriptions/<subscription-id>/agent-inbox/classification
→ { subscriptionId, classified, profile, checkedAt } | { error, code? }
```

This route never classifies. Per-bot activity is filtered on the server by subscription and recipient:

```
GET /api/agent-chat/dispatch-outcomes?subscriptionId=<id>&agentId=<profile-id>
```

The FD Dispatch tab and the workspace details page show these rows. A bot's own view never includes outcomes recorded for other bots.

## Opting in

- **Existing profile-bound subscription:**
  - `POST /api/agent-chat/subscriptions/<id>/agent-inbox {"mode":"inbox_required"}`.
  - `{"mode":"legacy"}` rolls back. A classified bot then stops receiving dispatch; it is never given broader access.
- **Inbox-first creation or migration:**
  - Use `POST /api/agent-chat/subscriptions` (direct create or update, for example migrating an existing profile without a fresh package) or `POST /api/agent-chat/agent-connect/import`.
  - Pass `agentProfileId` and `"agentInboxMode":"inbox_required"`.
  - The mode is set before any verification or event connection, so the new subscription never calls `/me`, `/events` or audience routes.
  - Other values are rejected, as is a request without a profile.
  - Creating a profile subscription in legacy mode and opting in later leaves a short window in which broad events reach that subscription's stored diagnostics.
  - **Compatibility limitation:** the NStack connect onboarding flow does not pass this option. It still creates legacy-mode subscriptions, and existing connections are unchanged.
- **Shared audience cleanup:** a migrated bot leaves the shared subscription's audience when that subscription reconciles. Reconciliation happens on reconnect or through `POST /api/agent-chat/subscriptions/actions/refresh-audiences`. Tower classification also removes the bot's audience rows.

## Sessions after migration

- **Fresh sessions.** Sessions created for an inbox delivery carry `flightdeckDeliveryMode: "agent_inbox"`. During an inbox delivery, chat, task and document sessions without that marker are never reused or natively resumed. This applies to sessions from before the migration and to sessions from another subscription. A fresh generation starts instead, and the previous session IDs are kept.
- **Reads.** These come only from the bound notification context: thread, task, document and comments. Generic Tower transport, record sync and context-tree helpers are refused.
- **Writes.**
  - `chat reply`, `task comment`, `doc reply`, `doc create` and `file upload` go through the Autopilot helper with the bot's own key.
  - They are allowed only into a thread, task, document or channel that a handled notification binds. Otherwise the error is `agent_inbox_write_unbound`.
  - Tower re-checks binding for classified bots.
- **File upload.** The helper uses the existing storage prepare → PUT → complete flow and then links the object as a channel file. Uploads are limited to 25 MiB.
- **Mentions.** Pass structured mentions to address another agent: MCP `mentions`, or CLI `--mentions-json '[{"type":"agent","npub":"npub1…","label":"Name"}]'`.
  - The visible `@[Label](mention:agent:npub)` tag is derived from the same value.
  - A visible tag without a structured entry is reported as a warning, because it never routes.

## Pipelines

- **Routing.** The pipeline router builds its context from the notification's bounded transcript.
- **Invocation.** `flightdeck.threadInvocation` takes the channel and thread from the bound notification instead of scanning workspace scopes and channels.
- **Replies.** Pipeline replies go only to a thread bound in the subscription's ledger.
- **Learning pipelines are not compatible with a classified bot.** They call Tower `/api/v4/learning/*`, and Tower's ceiling refuses those routes for a classified bot.

## Known limitations

- **Self-mentions.** Tower never notifies the author of a source. A bot that deliberately mentions itself, or that later works on records it created, gets no notification binding for them. Do not classify such bots until the Tower contract covers this.
- **Approvals and flow steps.** These still exist only on the legacy feed.
- **Activation.** Source changes take effect only after an Autopilot restart.
