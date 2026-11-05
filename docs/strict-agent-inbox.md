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
  - Opting in is final: `{"mode":"legacy"}` is refused (`409 agent_inbox_downgrade_refused`) for any subscription in `inbox_required`. To stop a bot, pause or disconnect it; its Tower delivery classification stays in place.
- **New bot connections (default):**
  - Every new subscription is a profile-bound Flight Deck PG strict inbox. This covers the Workspaces UI, `POST /api/agent-chat/subscriptions`, `POST /api/agent-chat/agent-connect/import`, NStack connect and SBIP-0009 kind 33357 discovery, all through `createOrUpdate`.
  - The mode is set before any verification or event connection, so a new bot never calls `/me`, `/events` or audience routes. Omitting `agentInboxMode` does not change this; `"inbox_required"` is still accepted, other values are rejected.
  - The profile must be named exactly: `agentProfileId` (UI and NStack offer a bot profile choice), or the 33357 recipient when it maps to an owned profile. Autopilot never probes local bots' workspace membership to pick one.
  - Without a profile and with no existing shared record to reconnect, the request fails with `400 agent_inbox_profile_required` before any key generation, backend health check or Tower request. A new connection without a full Flight Deck PG descriptor fails with `agent_inbox_flightdeck_pg_required`.
  - Before its inbox loop creates a Tower inbox subscription, polls or dispatches anything, a newly connected bot must hold Tower's notification-only delivery classification (addressed-only inbox; never an API ceiling). Autopilot reads the existing `GET …/agent-notifications/access-profile`. If the classification is absent, it self-classifies with the existing `PUT` and accepts only Tower's confirmation. It re-verifies on every loop start. If it cannot verify, the subscription is `blocked` (`agent_inbox_ceiling_unverified`) and nothing is dispatched.
  - Like every strict-inbox subscription, it can never be moved back to the legacy feed.
  - A profile-bound request never reuses or re-binds a profileless (shared) record of the same bot npub; it gets its own record.
  - A replayed or older 33357 event never re-enrolls a workspace the bot was locally disconnected from, under any binding.
- **Existing records:** reconnect with their mode unchanged; there is no global cutover. Migrate a profile deliberately with the opt-in route above or with `agentInboxMode` on an update.
- **Legacy shared audience (existing shared records only):**
  - It never grows. Before registering, Autopilot reads Tower's exact existing registration (`GET …/event-subscription-agents`, as the shared identity). It then requests only eligible profiles that hold an accepted-audience link to that subscription AND whose current npub Tower already registers. Links only narrow, since a profile's npub can change. `legacy_broad_feed_consent` is never sent.
  - If the registration cannot be read, or eligible bots exist but none qualifies, legacy delivery stops (`flightdeck_pg_legacy_audience_unrecoverable`, row `blocked`) with no audience `PUT` and no `/events`. When Tower denies audience management, only the profile whose npub is the subscription's own identity is served.
- **Shared audience cleanup:** a migrated bot leaves the shared subscription's audience when that subscription reconciles. Reconciliation happens on reconnect or through `POST /api/agent-chat/subscriptions/actions/refresh-audiences`. Tower classification also removes the bot's audience rows.

## Sessions after migration

- **Fresh sessions.** Sessions created for an inbox delivery carry `flightdeckDeliveryMode: "agent_inbox"`. During an inbox delivery, chat, task and document sessions without that marker are never reused or natively resumed. This applies to sessions from before the migration and to sessions from another subscription. A fresh generation starts instead, and the previous session IDs are kept.
- **Access.** The strict inbox is a delivery profile: it decides which notifications wake the bot. It does not limit what the session may do. Session tools and the `flightdeck` CLI are the ordinary ones, signed by the session's own bot through the capability broker (the signer is pinned to the session; the bot's configured signing policy bounds what may be signed) and authorized by Tower against the bot's ACL. There is no exact-trigger restriction on reads or writes.
- **Origin.** A session's *origin* is the one exact notification it was started or prompted for. It is provenance only: writes inside its location name it. Autopilot never picks "the newest notification for this location" and never borrows another session's notification.
  - Chat, task and document sessions: the origin is recorded when a turn's prompt is actually delivered, from that turn's own trigger. A notification that is only queued behind a running turn does not change it. Only a delivery that is provably refused is retracted. Any other failure may have been accepted, so the session keeps the intended origin and never falls back to an older one. A turn without a notification (legacy session path) is recorded as unbound and acts for nothing.
  - Pipeline runs: the notification that started the run. The run's sessions and its thread reply act only for it.
  - Dispatched workers: the parent's origin at dispatch time, fixed for the worker's lifetime. A manager's later callback turns keep the manager's own origin.
  - An origin is live only while its attempt is being dispatched, or after it was handled. It must also be at or after the subscription floor and not revoked. Failed, suppressed, revoked and pre-floor notifications never act, and there is no renewal (`agent_inbox_origin_expired`). A session without an origin gets `agent_inbox_no_origin`.
- **Reads.** Thread, task, document, comment, record-sync, transport and context-tree reads go to Tower as ordinary bot requests. Tower's ACL refusals are returned unchanged.
- **Writes.**
  - `chat reply`, `task comment`, `doc reply`, `doc create`, `task create`, `file upload`, `task state` and `doc update` go through the Autopilot helper with the bot's own key (structured mentions and instruction signatures). A write in another workspace uses the ordinary signed client.
  - A chat reply, doc, task or file created inside the current live origin's location names `origin_notification_id` (Tower may mint a provenance `work_receipt`). Anywhere else the write is an ordinary bot write; it is never refused for lacking an origin.
- **File upload.** The helper uses the existing storage prepare → PUT → complete flow and then links the object as a channel file. Uploads are limited to 25 MiB.
- **Mentions.** Pass structured mentions to address another agent: MCP `mentions`, or CLI `--mentions-json '[{"type":"agent","npub":"npub1…","label":"Name"}]'`.
  - The visible `@[Label](mention:agent:npub)` tag is derived from the same value.
  - A visible tag without a structured entry is reported as a warning, because it never routes.

## Pipelines

- **Routing.** The pipeline router builds its context from the notification's bounded transcript.
- **Invocation.** `flightdeck.threadInvocation` takes the channel and thread from the bound notification instead of scanning workspace scopes and channels.
- **Replies.** Pipeline replies go only to the thread of the notification that started the run, while it is live.
- **Learning pipelines** call Tower `/api/v4/learning/*`, authorized like any other bot request; an explicit learner delegation can be named:
  - The delegation is named by the `x-learning-grant-id` header and a matching signed `learning_grant_id` NIP-98 tag.
  - The manager sets the delegation per agent and Tower with `PUT /api/agent-chat/agents/<agent-id>/learning-grants` (`{"workspaceId","grantId","learnerNpub?"}`). It never comes from chat or a model.
  - The router's learner check and the learning pipeline's space-graph commands (`--grant-id`) carry it.
  - Without a mapping, the existing implicit learner selection is unchanged.

## Work receipts (provenance)

Creates inside the current origin's location send `origin_notification_id`; Tower may mint a version-bound `work_receipt`, which the helper returns unchanged. A receipt records which notification the output was produced for. It grants nothing: follow-up reads and updates of the bot's own output are ordinary ACL-authorized requests.

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
