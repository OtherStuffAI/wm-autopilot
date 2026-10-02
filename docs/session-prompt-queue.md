# Active-session prompt queue inspection and acknowledgement

Autopilot owns the ordinary prompt queue. A running agent can inspect and acknowledge its own queued prompts during an active turn when it already handled the work through another source. Acknowledgement records handling without starting another turn. It does not acknowledge supervised-dispatch callbacks.

## Commands

Use the Wingman CLI `session queue` group (local entry point: `bun clis/wingman.ts`):

```sh
bun clis/wingman.ts session queue list
bun clis/wingman.ts session queue acknowledge <item-id> --revision <read-revision> --reason "Completed through another source in this turn"
```

Both commands default to `SESSION_ID`. `--session <full-session-id>` explicitly selects a target; agent capabilities still deny another session. `--url` overrides `WINGMAN_URL` (default `http://127.0.0.1:3600`). Output is JSON. The new command group always uses the capability broker, never a raw key. It requires the existing agent `SESSION_ID` and `WINGMAN_CAPABILITY` environment. Session capability refresh/reissue follows the existing broker client.

The sessions CLI also supports:

```sh
bun clis/sessions.ts queue --json
bun clis/sessions.ts queue-acknowledge <item-id> --revision <read-revision> --reason "Completed in this turn"
```

The legacy queue reader now reads `queue.prompts` correctly and prints full IDs and revisions. Owner queue add/edit/delete/send controls remain available under their existing authentication and ownership rules. Queue acknowledgements must carry the NIP-98 payload hash even with a broad signing preset. Custom Nostr event signing cannot mint unbound queue authentication; use the supported NIP-98 broker operation. Agent queue authority grants only exact self-session list and acknowledge; it does not grant queue edits, deletion or forced dispatch.

## HTTP and revision contract

- `GET /api/sessions/:sessionId/queue`: `{ id, queue: { prompts, handled, maxSize: 21 } }`.
- `POST /api/sessions/:sessionId/queue/:itemId/acknowledge`: JSON `{ "revision": "1", "reason": "Completed via callback during this turn" }`. Returns `{ id, prompt, queue }`.
- Each item has a stable UUID `id`, full content, timestamp, type/payload, queue order, `state`, and `revision`. Revisions are positive decimal strings (`^[1-9][0-9]*$`), starting at `"1"`. Every edit increments the counter, including an edit back to identical content. Reordering does not increment it.
- Acknowledge the revision actually read. Do not fetch a fresh revision inside an automatic acknowledge command or infer handling from equal prompt text.
- Handling atomically compares session, item ID, revision and pending state. An identical actor/revision/trimmed-reason retry returns the original record and timestamp. A changed revision, dispatch claim, dispatched item, or different handling actor/reason returns HTTP 409. Missing item returns 404; missing revision or blank reason returns 400. Acknowledgement requires a running session; an active busy turn is supported.
- The durable handled record retains content, revision, `handledAt` (ISO UTC), `handledBy` (`session:<sessionId>` for broker agents; authenticated subject for owner actions), and `handledReason`. Handled items leave the pending queue and capacity count, remain readable in `queue.handled`, and appear as **Handled** historical events in the Dexie-backed live timeline. Queue refresh updates the pending count during active turns and after reload.

## Dispatch arbitration and migration

On opening the queue database, existing rows migrate in place to revision 1 and pending state. IDs/content/payloads remain intact. History and claims persist in the same SQLite database. The active deduplication index excludes handled/dispatched rows.

SQLite immediate transactions serialize acknowledgement and dispatcher claims across store connections. Dispatch claims the exact item before any delivery await. If acknowledgement wins, that item cannot be claimed. If dispatch wins, acknowledgement and owner edit/delete conflict or refuse the operation. Successful delivery completes only that item/claim token, never whichever item is now at the queue head.

An explicit busy rejection releases its exact claim. Ambiguous delivery failures or a crash preserve the claim and block automatic resend; the UI shows **Dispatching** and inspection exposes `state: "claimed"`. Dispatch responses flag uncertain claims with `reviewRequired: true`; the UI surfaces the error without suggesting manual resend. Claims have no automatic expiry because expiry cannot prove a prompt was not submitted. Investigate the adapter conversation and delivery evidence before operator recovery; do not blindly clear a claim. This feature does not introduce a recovery CLI for uncertain delivery.

## Separate durable callback inbox

Continue using `wingman dispatch inbox`, `acknowledge <dispatch-id>`, and `close <dispatch-id>` for supervised-dispatch results. Callback handling invalidates obsolete wake claims and clears stale wake retries. The dispatcher revalidates the exact unresolved fingerprint and wake attempt after readiness and immediately before adapter/network submission. Closing an older callback never closes a later arrival. A wake already submitted before handling cannot be unsent; it remains a separate delivery boundary.

## Validation and activation

Focused store/API/CLI/broker/dispatcher tests use disposable queues. The optional browser test uses actual Alpine, Dexie/IndexedDB and UI modules with a disposable loopback server:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium \
bun test ./scripts/prompt-queue-acknowledge.browser.test.ts
```

`CHROMIUM_EXECUTABLE` is optional when Playwright has its matching browser installed. Existing live queues are never test fixtures.

A running Autopilot server must be restarted by the operator to activate the migration, new API/broker guards and dispatch lifecycle. Reload the browser after activation. Managed agents must not restart the host without explicit operator approval acknowledging interruption of active sessions. No Tower migration or Flight Deck task/chat record is required.
