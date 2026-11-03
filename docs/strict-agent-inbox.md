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
- **Origin.** Every session tool call acts for one exact notification, its *origin*. Autopilot never picks "the newest notification for this location" and never borrows another session's notification.
  - Chat, task and document sessions: the origin is recorded when a turn's prompt is actually delivered, from that turn's own trigger. A notification that is only queued behind a running turn does not change it. Only a delivery that is provably refused is retracted. Any other failure may have been accepted, so the session keeps the intended origin and never falls back to an older one. A turn without a notification (legacy session path) is recorded as unbound and acts for nothing.
  - Pipeline runs: the notification that started the run. The run's sessions and its thread reply act only for it.
  - Dispatched workers: the parent's origin at dispatch time, fixed for the worker's lifetime. A manager's later callback turns keep the manager's own origin.
  - An origin is live only while its attempt is being dispatched, or after it was handled. It must also be at or after the subscription floor and not revoked. Failed, suppressed, revoked and pre-floor notifications never act, and there is no renewal (`agent_inbox_origin_expired`). A session without an origin gets `agent_inbox_no_origin`.
- **Reads.** These come only from the origin's bound context (or an earlier turn of the same session): thread, task, document and comments. Generic Tower transport, record sync and context-tree helpers are refused.
- **Writes.**
  - `chat reply`, `task comment`, `doc reply`, `doc create`, `task create` and `file upload` go through the Autopilot helper with the bot's own key.
  - They are allowed only into the thread, task, document or channel of the current origin. Otherwise the error is `agent_inbox_write_unbound`.
  - Tower re-checks binding for classified bots.
- **File upload.** The helper uses the existing storage prepare → PUT → complete flow and then links the object as a channel file. Uploads are limited to 25 MiB.
- **Mentions.** Pass structured mentions to address another agent: MCP `mentions`, or CLI `--mentions-json '[{"type":"agent","npub":"npub1…","label":"Name"}]'`.
  - The visible `@[Label](mention:agent:npub)` tag is derived from the same value.
  - A visible tag without a structured entry is reported as a warning, because it never routes.

## Pipelines

- **Routing.** The pipeline router builds its context from the notification's bounded transcript.
- **Invocation.** `flightdeck.threadInvocation` takes the channel and thread from the bound notification instead of scanning workspace scopes and channels.
- **Replies.** Pipeline replies go only to the thread of the notification that started the run, while it is live.
- **Learning pipelines** call Tower `/api/v4/learning/*`. Tower's ceiling admits a classified bot there only on its allowlisted learning routes, and only with an explicit learner delegation.
  - The delegation is named by the `x-learning-grant-id` header and a matching signed `learning_grant_id` NIP-98 tag.
  - The manager sets the delegation per agent and Tower with `PUT /api/agent-chat/agents/<agent-id>/learning-grants` (`{"workspaceId","grantId","learnerNpub?"}`). It never comes from chat or a model.
  - The router's learner check and the learning pipeline's space-graph commands (`--grant-id`) carry it.
  - Without a mapping, the existing implicit learner selection is unchanged. That only works while the bot is unclassified.

## Work receipts (own output follow-ups)

Creates from a strict-inbox session (`doc create`, `task create`, `file upload`) send `origin_notification_id`. Tower may then mint a version-bound `work_receipt`, which the helper returns unchanged.
- Autopilot keeps only receipts Tower returned for the exact entity and origin it sent. They narrow what the session may do and never grant beyond Tower.
- When the session's origin does not bind that entity, the receipt lets the bot follow up on its own output:
  - `doc show`/`doc update`, `task show`/`task state`, a top-level `task comment`, and `file show` (metadata only).
  - Only the session that acted for the receipt's origin (or a worker or manager sharing it) may use it, and only while that origin is live.
  - Only at the receipted version. A human edit, or a different body or file version, gives `409 agent_inbox_work_output_changed` with no content.
  - After the bot's own update, Autopilot follows the advanced receipt Tower returns. If Tower returns none, the receipt is dropped and later follow-ups fail closed.
- Comments, comment replies, attachments, file downloads and history are never served through a receipt.

## Self-address

A chat reply whose structured mentions include the bot itself (`{"type":"agent","npub":<own npub>}`) is a deliberate self-address.
- Autopilot sends `origin_notification_id` and adds a `mentions_sha256` tag to the message's kind-33358 instruction signature. The value is the lowercase hex SHA-256 of `JSON.stringify` of the deduped `{type, npub}` list, lowercased and sorted by npub then type.
- `origin_notification_id` is the live non-self notification the session acts for. For a turn that was itself a self-address, it is the non-self notification that self-address named.
- Ordinary messages carry neither, unchanged.
- Tower decides whether to project the self-address (verified signature, live origin, current ACL). Autopilot still decides whether to execute it (instructor grants).
- A `self_mention` notification binds nothing by itself. A session acting for one may write only while the non-self notification it names is live.

## Known limitations

- **Self-mentions.** Projection of a deliberate self-address needs the matching Tower contract (reason `self_mention`). Until Tower runs it, a bot that mentions itself is not notified. Do not classify such bots before then.
- **Approvals and flow steps.** These still exist only on the legacy feed.
  - Flight Deck PG tasks carry no flow linkage, so inbox task triggers are handled like legacy Flight Deck PG task events.
  - If a task's inbox context ever carries flow markers, the trigger is acknowledged `failed_permanent` with code `agent_inbox_flow_unsupported`. It is never run as an ordinary task.
- **Activation.** Source changes take effect only after an Autopilot restart.
