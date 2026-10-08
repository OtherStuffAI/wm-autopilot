# Trigger execution identity

Session and pipeline triggers require an explicit **Run as identity**, separate
from engine (Codex, Claude, etc.) and model. Creation starts with no identity
selected. The picker displays the bot profile name and full npub; saved summaries
also expose the npub for inspection.

`GET /api/scheduler/identities` lists active keys owned by the authenticated
scheduler owner that have an enabled, non-archived profile. The response contains
only `{ botNpub, name }` public metadata. The browser writes this listing to Dexie
before Alpine reads it. Loading failures block identity-dependent saves and offer
a retry. Missing or unavailable saved identities remain visible without selecting
a replacement.

`POST /api/scheduler/jobs` requires `botNpub` for session and pipeline actions.
There is no implicit instance-identity default. CLI callers must supply
`--bot-npub <npub>`. Existing API owner/active-key validation rejects foreign and
retired identities. UI edits include the chosen npub. Unrelated API patches retain
the saved identity; existing triggers are not automatically migrated.

Session launches pass the saved npub as `agentChatBotNpub`. Scheduled pipeline
runs pin it as their initiating signer, which propagates to agent workers and
child runs. Pipeline input profile bindings cannot override that signer. The
scheduled launch deliberately resolves the profile from the exact npub instead
of passing a potentially rotated saved profile ID.

Cleanup runs without a bot signer and remains usable when identity loading fails.
Changing an action to cleanup clears its identity binding.

Selecting a signer does not configure Flight Deck workspace, subscription,
delegation or WApp routing. Those require their own validated context. The
optional `clis/bind-scheduled-flightdeck.ts --config <private-route.json>` helper
validates the calling scheduled session, trigger and subscription, updates only
that session, then checks metadata readback and live broker context. It does not
change live triggers or grant authority.

Backend changes require an operator-managed Autopilot restart. After activation,
reload the browser, verify owner-scoped identities, create a disabled test trigger,
edit/read back its npub, and inspect a controlled session/pipeline worker's actual
broker identity before enabling scheduled execution.
