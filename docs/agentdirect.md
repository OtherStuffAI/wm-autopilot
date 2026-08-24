# Agent Direct Chat: Autopilot MVP Design

## Purpose

Agent Direct Chat connects a Flight Deck channel thread directly to a normal Autopilot agent session. In shared channels a human canonically mentions an agent such as the workspace agent on each message intended for it; in a strict two-party DM the sole human participant may speak without a mention. Autopilot consumes the Tower PG message event, creates or reuses one session for that workspace/channel/thread/agent tuple, supplies the authoritative conversation context, and publishes the agent's answer to Tower as an ordinary chat message without a pipeline.

This feature should harden and simplify the existing `src/agent-chat/` runtime. It is not a new pipeline and does not require ACP. ACP may later implement an internal conversational session adapter, but event routing, delivery cursors, lifecycle recovery, and Tower publication remain Autopilot responsibilities.

## System Ownership

- Flight Deck authors structured mentions and channel configuration and renders normal messages.
- Tower authorizes and stores chat records, emits ordered visible events, provides authoritative thread reads, and accepts idempotent agent-authored messages.
- Autopilot owns routing, local agent/project configuration, thread/session binding, session lifecycle, prompt delivery, final-response selection, and reply publication.

## MVP Behavior

1. Receive a Tower PG `message.created` event visible to the registered agent subscription.
2. Fetch the authoritative message, channel, and thread state.
3. Ignore self-authored, duplicate, inaccessible, disabled, or unrelated messages.
4. Require a canonical mention of the target agent on every shared/system-channel message, or verify strict two-party DM eligibility.
5. Create a normal session in the configured project directory and deliver the bootstrap prompt.
6. Select the agent adapter's authoritative completed final response and publish it verbatim through Tower's typed message API.
7. Persist delivery and publication cursors.
8. Reuse the binding for later eligible messages; the binding provides continuity, never trigger eligibility.
9. Reuse a live session, natively resume a stopped session, or create a continuity replacement when recovery is impossible.

## Existing Runtime to Reuse

The current `src/agent-chat/` implementation already provides much of the foundation:

- Flight Deck PG event consumption and message normalization;
- routing by workspace/channel/thread/bot;
- `chat_intercept_state` persistence;
- duplicate event suppression;
- session creation and reuse;
- pending turn queues and merged follow-ups;
- turn interruption handling;
- idle retention and archival;
- Tower PG thread context and reply publication helpers;
- suppression of workspace-key/bot-authored messages.

The MVP should evolve this code rather than introduce a parallel direct-chat service.

## Routing Identity

The canonical routing key is:

```text
tower_service_npub + workspace_id + channel_id + thread_id + agent_npub
```

Do not use only channel/thread IDs. IDs can collide across Towers or workspaces, and one thread may eventually contain more than one agent.

The target agent is resolved from the canonical npub in structured mentions stored by Tower and the registered Autopilot agent definition. Flight Deck may present that identity with either `type: "agent"` or `type: "person"`; presentation type does not change routing. Visible `@Name` text is not authoritative.

## Activation Rules

The legacy `activation: mention_then_continue` configuration value remains accepted for compatibility, but runtime eligibility is:

- ordinary `channel` and `system` channels: every human message must canonically mention this agent, regardless of an existing binding;
- strict two-party `dm`: an unmentioned message is eligible only when `participant_npubs` contains exactly two distinct non-empty npubs, includes this agent, and the event author is the other participant;
- all channels are Direct-enabled by product default; `metadata.agent_chat.enabled: false` is the explicit opt-out;
- malformed or multi-party DMs, DMs missing this agent, and messages authored outside the declared pair require a canonical mention;
- an existing binding or live session never makes an otherwise ineligible message actionable;
- target agent authored the message: ignore;
- mapped workspace/session key for the target agent authored the message: ignore;
- another agent alone is mentioned: do not activate this agent;
- Agent Direct Chat is disabled on the channel: ignore;
- duplicate event/message: acknowledge internally without another turn.

A binding remains meaningful when its process is idle, stopped, or archived. Turn completion does not unbind the Flight Deck thread.

## Agent Launch Configuration

Extend or normalize the existing agent definition with a direct-chat launch profile:

```json
{
  "agent_id": "agent",
  "label": "the workspace agent",
  "bot_npub": "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpscums9v",
  "direct_chat": {
    "enabled": true,
    "session_agent": "codex",
    "directory": "/srv/workspace",
    "model": null,
    "idle_retention_minutes": 60
  }
}
```

For the MVP this configuration is local to the owning Autopilot. A future Flight Deck setting may select a portable project/profile identifier, but Flight Deck must not be allowed to make Autopilot execute in an arbitrary absolute path. Autopilot resolves any future portable identifier through an allowlisted local profile.

## Persistent Binding and Delivery State

Migrate `chat_intercept_state` or introduce an explicitly related table so the persisted record contains:

```text
routing_key
subscription_id
agent_id
session_id
session_generation
previous_session_ids_json
tower_service_npub
workspace_id
channel_id
thread_id
target_bot_npub
last_event_cursor_seen
last_human_message_id_delivered
last_agent_message_id_published
last_completed_turn_id
pending_message_count
state
last_activity_at
created_at
updated_at
```

Important distinctions:

- `last_event_cursor_seen` means Autopilot consumed an event.
- `last_human_message_id_delivered` means the human message was accepted into an agent turn.
- `last_agent_message_id_published` means Tower accepted the reply.
- `last_completed_turn_id` means all side effects for the turn are complete.

Do not overload `last_message_id_seen` for all four meanings. Preserve compatibility during migration and populate the stronger fields as events are processed.

## Authoritative Context Loading

Event payloads are notifications, not the complete source of truth. Before routing or prompting:

1. fetch the current channel and its `agent_chat` configuration;
2. fetch the triggering message from the typed Tower route or authoritative channel message list;
3. fetch the complete canonical thread in stable order;
4. resolve the message authors supplied by Tower;
5. verify the latest relevant message is not authored by this agent or its mapped key;
6. compute the undelivered human-message delta from persisted message IDs.

Do not reason from a stale event excerpt when the Tower thread can be fetched.

## Session Creation

Create a normal session through the existing process manager/session lifecycle, not a pipeline run. Session metadata must include:

```json
{
  "AGENT": true,
  "sessionClass": "flightdeck_chat",
  "flightdeckTowerServiceNpub": "...",
  "flightdeckWorkspaceId": "...",
  "flightdeckScopeId": "...",
  "flightdeckChannelId": "...",
  "flightdeckThreadId": "...",
  "flightdeckAgentNpub": "...",
  "flightdeckRoutingKey": "...",
  "sessionGeneration": 1
}
```

For the workspace agent's MVP profile, the directory is `/srv/workspace` and the default agent is the locally configured default unless the direct-chat profile overrides it.

Persist the binding as soon as the session is created. If prompt delivery fails, retain recoverable state rather than creating another session blindly on the next duplicate event.

## Bootstrap Prompt Contract

The first prompt must clearly separate durable context from the immediate message:

```text
AGENT DIRECT CHAT

CHANNEL CONTEXT
<channel agent_chat.context_prompt, possibly empty>

FLIGHT DECK SOURCE
tower_service_npub: ...
workspace_id: ...
scope_id: ...
channel_id: ...
thread_id: ...
trigger_message_id: ...

THREAD HISTORY JSON
[
  {
    "message_id": "...",
    "user_id": "...",
    "user_npub": "...",
    "created_at": "...",
    "message": "..."
  }
]

NEXT MESSAGE
message_id: ...
user_id: ...
user_npub: ...
message: ...

Answer normally with a polished response using GitHub-Flavored Markdown where useful. Your normal final response is published verbatim to Flight Deck: do not add a wrapper or envelope, invoke a reply helper, or enclose the whole response in a code fence.
```

Attachments should be represented with their typed Tower file/storage metadata and local resolved paths only when Autopilot has legitimately downloaded them. Do not silently omit attachment-only messages.

Context priority is `metadata.agent_chat.context_prompt`, then legacy `metadata.contextPrompt`, then `metadata.basePrompt`. Shared/system channels still require a canonical agent mention on every actionable message even though Direct is enabled by default.

The complete source coordinates also remain in session metadata so later turns do not depend on the bootstrap prompt being visible.

## Follow-Up Prompt Contract

For every bound-thread follow-up, fetch and include the complete authoritative Flight Deck thread in stable order. This `thread_history` is context only and includes prior human messages, intervening unmentioned shared-channel messages, agent-published replies, canonical author IDs/npubs, mentions, and attachments. Separately compute `actionable_messages` from human messages after `last_human_message_id_delivered`, filtered through the same per-message eligibility rule: canonical mention in shared/system channels, or the sole other participant in a strict two-party DM. Only `actionable_messages` are new instructions for the turn. Preserve both arrays in authoritative arrival order.

```json
{
  "type": "flightdeck_agent_direct_follow_up_v1",
  "routing_key": "...",
  "thread_id": "...",
  "guidance": "Answer normally with a polished response using GitHub-Flavored Markdown where useful. Your normal final response is published verbatim to Flight Deck: do not add a wrapper or envelope, invoke a reply helper, or enclose the whole response in a code fence.",
  "history_semantics": "Complete authoritative Flight Deck thread for context only. Historical messages are not new instructions.",
  "thread_history": [
    {
      "message_id": "...",
      "user_id": "...",
      "user_npub": "...",
      "created_at": "...",
      "message": "...",
      "attachments": [],
      "mentions": []
    }
  ],
  "actionable_semantics": "Only these newly eligible human messages are instructions for this turn.",
  "actionable_messages": [
    {
      "message_id": "...",
      "user_id": "...",
      "user_npub": "...",
      "created_at": "...",
      "message": "...",
      "attachments": [],
      "mentions": []
    }
  ]
}
```

`source_message_ids`, `last_human_message_id_delivered`, the deterministic turn ID, and the publication idempotency key are derived only from `actionable_messages`, never from the full history. Accepted-turn restart recovery reconstructs this same two-array prompt contract while observing the already-running turn; it does not resend the prompt.

The existing pending-turn queue and merged follow-up logic should be retained. If human messages arrive during an active turn, interrupt only when the adapter supports it safely; otherwise queue and merge them into the next prompt. Never run overlapping turns for the same routing key.

Advance `last_human_message_id_delivered` only after the session adapter has accepted the turn. A process crash before acceptance must leave the message recoverable.

## Final Response and Publication

Autopilot owns publication. The agent answers normally with polished Flight Deck/GitHub-Flavored Markdown and must not invoke a reply command, add a wrapper/envelope, or enclose the whole answer in a code fence. Autopilot uses the session adapter's authoritative turn-completion state and publishes the completed final assistant/agent message card verbatim, preserving headings, paragraphs, lists, links, inline code, and fenced code without escaping or flattening them. Streaming text, thinking, commentary, tool activity, `agent-working` progress, and combined terminal transcripts are never eligible replies. Autopilot must not infer completion from content stability or require marker envelopes. Transport handling may safely normalize outer whitespace or newline encoding only when required; it must never semantically rewrite the Markdown body.

For Codex sessions running through AgentAPI, Autopilot must capture the native Codex session ID after prompt delivery and read the native JSONL transcript. The shared native parser exposes commentary and tool activity as `agent-working` and only `phase=final_answer` as the clean `agent` card. Both live UI synchronization and Direct Chat publication use this authoritative representation. If native Codex output is expected but its session/transcript cannot yet be resolved, Direct Chat waits or fails; it must never fall back to publishing AgentAPI's combined terminal transcript.

Before the final Tower write, Autopilot suppresses a response beginning with the selected workspace's duplicate-callback marker (default `duplicate callback:`) when its persisted final-response timestamp is no more than that workspace's configured window (default `180` seconds) after the immediately previous successful publication on the same Tower/workspace/channel/thread/agent routing key. Configure both values in **Settings > Workspaces > Routing**. Matching is case-insensitive and permits only leading ASCII spaces or tabs, not a leading newline. Exactly 180 seconds is inside the default window. Missing or invalid timestamps fail open. Set the marker to an empty value or the window to `0` to disable the rule; change the marker explicitly to support another exact prefix rather than relying on fuzzy typo matching.

On turn completion:

1. wait for authoritative adapter turn completion and select the new non-empty final assistant/agent message;
2. if the turn completes without a final message, record a failed turn without publishing progress or tool output;
3. derive a deterministic turn ID;
4. create a Tower PG message signed by the agent;
5. use `client_request_id = agentdirect:<routing-key-hash>:<turn-id>`;
6. set the correct channel and thread;
7. include descriptive provenance metadata;
8. save Tower's returned message ID;
9. mark the turn complete and the binding idle.

Suggested provenance:

```json
{
  "source": "autopilot_session",
  "session_id": "<session-id>",
  "turn_id": "<turn-id>",
  "source_message_ids": ["<human-message-id>"],
  "agent_npub": "<agent-npub>"
}
```

Tower derives the real author from the NIP-98 signer. Metadata must never be treated as authentication.

If Tower accepts a message but Autopilot crashes before saving the result, retry the same `client_request_id`. Tower must return the existing message, preventing duplicate replies.

## Session Lifecycle and Recovery

Resolve a bound session in this order:

1. running/starting session: reuse it;
2. stopped or archived but native-resumable: use the existing native resume path and update the binding to the returned live session ID;
3. missing or not resumable: create a continuity replacement.

A continuity replacement increments `session_generation`, appends the old session ID to `previous_session_ids_json`, and receives:

- channel context;
- full authoritative thread history;
- previous session identity and recovery reason;
- the undelivered human messages as the immediate next input.

Do not claim native continuity when a replacement session was created.

Idle retention may stop/archive the process, but it must not delete the routing binding or human-message delivery cursors. A later human message should transparently resume or recover.

On Autopilot startup, subscription recovery enumerates persisted non-completed Direct turns and hydrates their authoritative Tower channel/thread without waiting for a new event. A `reply_ready` turn retries its stored body with its stored `client_request_id`. An `accepted` turn observes the surviving session/native transcript after the stored source-message boundary, never resends the prompt, and promotes only a clean authoritative final to `reply_ready` before idempotent publication. If the final has not arrived, recovery waits safely. Repeated restarts must remain safe at every state.

Session metadata `nextAction: stop` means the current turn is complete. It does not mean the Flight Deck thread is unbound.

## Failure Handling

- Auth or workspace access failure: mark the binding blocked and retain queued message IDs.
- Thread fetch failure: do not answer from stale event content; retry through the subscription runtime.
- Session creation failure: keep the binding pending with no false delivered cursor.
- Prompt acceptance failure: leave human messages undelivered.
- Missing final agent response: record failure; do not publish thinking, progress, tools, or transcript output.
- Tower publication failure: retry with the same idempotency key.
- Duplicate event: do not create another session or turn.
- Self-authored event: skip without adding a response.

The runtime may expose response activity to Tower for UI feedback, but the chat reply itself remains a normal message.

## Single Implementation Work Package

Implement this MVP as one Autopilot work package named **Agent Direct Chat: durable Flight Deck thread session runtime**. Assign the complete package to one worker/session in this repository. Do not split routing, state migration, prompting, lifecycle recovery, publication, and tests into separate independently handed-off tasks: correctness depends on their shared cursor and idempotency semantics.

### Package objective

Turn the existing `src/agent-chat/` foundation into the complete direct conversational runtime: per-message shared-channel mentions plus strict two-party DM activation, one durable thread/agent binding, normal session create/resume, eligible delta follow-ups, authoritative final-response selection, and idempotent Tower publication.

### Prerequisites

- The Tower channel, mention, thread-read, event, and idempotent message-write contracts are agreed and represented in this document.
- the workspace agent's local direct-chat profile resolves to `/srv/workspace` with a valid agent identity and Tower workspace subscription.
- The implementation may use Tower contract fixtures during development, but final acceptance requires a compatible live Tower.

### Included work

- canonical routing identity, mention-each-shared-message activation, and strict two-party DM activation;
- persisted binding/cursor schema migration and startup recovery;
- local direct-chat launch profile resolution;
- authoritative Tower channel/message/thread hydration;
- bootstrap and follow-up prompt contracts;
- reuse, native resume, and continuity replacement lifecycle;
- pending-turn queue/merge behavior without overlapping turns;
- authoritative final-response selection and runtime-owned Tower publication;
- deterministic idempotency keys and publication recovery;
- self-authored/duplicate/access failure suppression;
- focused, migration, lifecycle, and integrated runtime tests.

### Explicit exclusions

- no pipeline-based implementation of the chat turn;
- no ACP adapter in the MVP;
- no Flight Deck UI work;
- no Tower schema implementation beyond client/fixture changes in this repository;
- no general redesign of unrelated task, document invocation, or workroom dispatch paths.

### Deliverables

- migrated durable binding state with backward-compatible startup behavior;
- updated agent profile/configuration surface;
- direct-chat runtime and extracted PG-native Tower client/publisher primitives;
- automated tests covering every acceptance case below;
- an integration fixture or smoke path demonstrating create, reply, follow-up, stop/resume, and retry;
- a handoff stating the compatible Tower and Flight Deck commits used for the vertical slice.

### Validation and definition of done

Run focused `agent-chat` tests throughout implementation and the repository's full relevant test suite before handoff. The package is done only when every Autopilot acceptance test below passes, restart recovery is verified against persisted state, Tower publication is idempotent, the workspace agent's configured directory is used, and the integrated Flight Deck mention-to-follow-up flow succeeds without a pipeline or agent-owned reply helper.

## Implementation Directions

1. Update PG event normalization in `src/agent-chat/subscription-runtime.ts` to preserve workspace ID, canonical mentions, author identity, and event cursor.
2. Update routing evaluation to implement mention-each-shared-message activation, strict two-party DM eligibility, and binding-only continuity.
3. Migrate `src/agent-chat/chat-intercept-state-store.ts` to the stronger binding/cursor model.
4. Extend `src/agent-chat/agent-definition-store.ts` and its configuration/API surface with the direct-chat launch profile.
5. Refactor `src/agent-chat/session-runtime.ts` and session operations so stopped bindings attempt native resume before replacement creation.
6. Update prompt builders in `src/agent-chat/session-runtime-prompts.ts` to use the bootstrap and follow-up contracts above.
7. Replace agent-owned reply-current instructions in the core direct-chat path with authoritative final-response selection and a runtime-owned publisher.
8. Reuse the PG-native Tower publisher/client code in `src/agent-chat/dispatch-pipelines/flightdeck-publisher.ts` where appropriate, but move or extract primitives so direct chat does not conceptually depend on a pipeline.
9. Retain queue, merge, interrupt, auth-block, and self-suppression behavior.
10. Add migrations and tests before enabling the feature for existing subscriptions.

The implementation may extract a `ConversationalSessionAdapter`:

```ts
interface ConversationalSessionAdapter {
  create(input: CreateConversationInput): Promise<SessionRef>;
  send(session: SessionRef, prompt: string): Promise<TurnResult>;
  resume(session: SessionRef): Promise<SessionRef>;
  interrupt(session: SessionRef): Promise<boolean>;
}
```

The existing native session/process-manager implementation is the MVP adapter. ACP can be added later without changing the Tower/Flight Deck contract.

## Acceptance Tests

1. A canonical the workspace agent mention in an enabled channel creates exactly one normal session in `/srv/workspace`.
2. Literal mention-like text without canonical mention metadata does not activate an unbound thread.
3. The bootstrap prompt contains channel context, source coordinates, complete ordered history, and a clearly marked next message.
4. A completed final response produces exactly one Tower message authored by the workspace agent, with Markdown preserved verbatim.
5. A the workspace agent-authored message event does not retrigger the workspace agent.
6. A later unmentioned shared-channel reply is ignored and leaves the existing session binding intact; a later mentioned reply reuses it.
7. An unmentioned message from the sole other participant in a strict two-party DM creates or reuses the session.
8. A strict two-party DM works without `metadata.agent_chat`; its legacy `metadata.basePrompt` supplies context when no Direct context prompt exists.
9. Missing-agent, multi-party, malformed, or outsider-authored DMs require a canonical mention unless explicitly opted out.
10. Two quick eligible human replies are delivered once, in order, without overlapping turns.
11. Duplicate Tower events do not produce duplicate sessions, prompts, or replies.
12. Publication retries with the same client request ID produce one Tower message.
13. A stopped resumable session uses native resume and preserves context.
14. An unrecoverable session creates a generation-two continuity replacement and records the old session ID.
15. Another agent in the same thread uses a separate routing key and session.
16. Access/auth failures retain undelivered eligible human messages and publish no speculative reply.
17. Restarting Autopilot restores bindings and cursors but does not waive per-message eligibility.
18. Restarting after a turn is persisted `accepted` recovers and publishes the surviving session's clean native final without resending the prompt or requiring a new human message.

## Cross-Project Delivery Contract

The MVP is complete only when the integrated path works:

```text
Flight Deck canonical mention (shared/system) or strict two-party DM message
→ Tower message.created event
→ authoritative Autopilot thread hydration
→ normal agent session create/resume
→ authoritative completed final response
→ idempotent Tower message write
→ ordinary Flight Deck agent reply
→ next eligible human message delivered to the same binding
```

See the corresponding `docs/agentdirect.md` documents in Flight Deck and Tower for their portions of the contract.
