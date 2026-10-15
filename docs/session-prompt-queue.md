# Active-session prompt queue inspection and acknowledgement

Autopilot owns the ordinary prompt queue. A running agent inspects its own queue and explicitly consumes each exact instruction once incorporated into current work. Consumption removes it from pending immediately without waiting for task completion or starting another turn. Reading/listing alone is inspection, not consumption. Successful ordinary dispatch already consumes its exact accepted item. It does not acknowledge supervised-dispatch callbacks.

## Commands

Use the Wingman CLI `session queue` group (local entry point: `bun clis/wingman.ts`):

```sh
bun clis/wingman.ts session queue list
bun clis/wingman.ts session queue consume <item-id> --revision <read-revision> --reason "Incorporated steering into current work"
bun clis/wingman.ts session queue acknowledge <item-id> --revision <read-revision> --reason "Completed through another source in this turn"
```

These commands default to `SESSION_ID`. `--session <full-session-id>` explicitly selects a target; agent capabilities still deny another session. `--url` overrides `WINGMAN_URL` (default `http://127.0.0.1:3600`). Output is JSON. The new command group always uses the capability broker, never a raw key. It requires the existing agent `SESSION_ID` and `WINGMAN_CAPABILITY` environment. Session capability refresh/reissue follows the existing broker client.

The sessions CLI also supports:

```sh
bun clis/sessions.ts queue --json
bun clis/sessions.ts queue-acknowledge <item-id> --revision <read-revision> --reason "Completed in this turn"
```

The legacy queue reader now reads `queue.prompts` correctly and prints full IDs and revisions. Owner queue add/edit/delete/send controls remain available under their existing authentication and ownership rules. Queue acknowledgements must carry the NIP-98 payload hash even with a broad signing preset. Custom Nostr event signing cannot mint unbound queue authentication; use the supported NIP-98 broker operation. Agent queue authority grants only exact self-session list, consume, acknowledge and reconcile; it does not grant queue edits, deletion or forced dispatch.

## HTTP and revision contract

- `GET /api/sessions/:sessionId/queue`: `{ id, queue: { prompts, handled, maxSize: 21 } }`.
- `POST /api/sessions/:sessionId/queue/:itemId/consume`: JSON `{ "revision": "1", "reason": "Incorporated into active work" }`. Uses the same exact-version atomic removal and retained history as acknowledgement; it records incorporation, not verified completion.
- `POST /api/sessions/:sessionId/queue/:itemId/acknowledge`: JSON `{ "revision": "1", "reason": "Completed via callback during this turn" }`. Returns `{ id, prompt, queue }`.
- Each item has a stable UUID `id`, full content, timestamp, type/payload, queue order, `state`, and `revision`. Revisions are positive decimal strings (`^[1-9][0-9]*$`), starting at `"1"`. Every edit increments the counter, including an edit back to identical content. Reordering does not increment it.
- Consume or acknowledge only the revision actually read. Do not fetch a fresh revision inside an automatic acknowledge command or infer handling from equal prompt text.
- Handling atomically compares session, item ID, revision and pending state. An identical actor/revision/trimmed-reason retry returns the original record and timestamp. A changed revision, dispatch claim, dispatched item, or different handling actor/reason returns HTTP 409. Missing item returns 404; missing revision or blank reason returns 400. Acknowledgement requires a running session; an active busy turn is supported.
- The durable handled record retains content, revision, `handledAt` (ISO UTC), `handledBy` (`session:<sessionId>` for broker agents; authenticated subject for owner actions), and `handledReason`. Handled items leave the pending queue and capacity count, remain readable in `queue.handled`, and appear as **Handled** historical events in the Dexie-backed live timeline. Queue refresh updates the pending count during active turns and after reload.

## Dispatch arbitration and migration

On opening the queue database, existing rows migrate in place to revision 1 and pending state. IDs/content/payloads remain intact. History and claims persist in the same SQLite database. The active deduplication index excludes handled/dispatched rows.

SQLite immediate transactions serialize acknowledgement and dispatcher claims across store connections. Dispatch claims the exact item before any delivery await. If acknowledgement wins, that item cannot be claimed. If dispatch wins, acknowledgement and owner edit/delete conflict or refuse the operation. Successful delivery completes only that item/claim token, never whichever item is now at the queue head.

Definitely unsent failures (including drain/message/adapter lookup and readiness exceptions) and explicit client rejection release only the exact claim. Before calling the adapter or HTTP receiver the store durably records `deliveryState: "uncertain"` and a unique `deliveryId` equal to the claim token. HTTP carries this identity for correlation, but the receiver does **not** promise deduplication. There is exactly one HTTP attempt: transport loss, timeout or server errors never trigger automatic HTTP/PM2 retries. Successful acceptance persists an `accepted` receipt before completing the claim. A crash in either gap keeps the claim visible and blocks FIFO until explicit recovery or a later authorised fresh-human inactive-session boundary. Legacy claims with no delivery state are uncertain. No claim expires or replays automatically.

### Explicit recovery

Inspect `wingman session queue list`, the receiver conversation and delivery evidence. The UI retains unresolved items and labels them **Delivery unresolved — inspect queue and reconcile explicitly**, including after refresh/reload. Use:

```sh
bun clis/wingman.ts session queue reconcile <item-id> \
  --revision <read-revision> --claim-token <read-claimToken> \
  --resolution accepted --reason "Receiver conversation confirms acceptance"
```

`accepted` records handled history without submitting work. `retry` instead returns the item to pending FIFO; it is an explicit decision permitting a new delivery and may duplicate work if previous acceptance cannot be excluded. Supply a considered reason describing receiver evidence and accepted duplicate risk. This is never an automatic timeout action. A definitely unsent crash can safely be resolved with `retry`; a recorded accepted receipt normally calls for `accepted`.

`POST /api/sessions/:sessionId/queue/:itemId/reconcile` accepts `{revision, claimToken, resolution: "accepted" | "retry", reason}` and returns the existing `{id,prompt,queue}` shape. It requires a running session and authenticated exact self-session capability or existing owner/admin authority. Missing fields/unknown resolution return 400; a stale revision/token/state or locally in-flight send returns 409. Resolution increments revision and atomically records actor, time, delivery identity, original revision, reason and decision in the recovery audit table. A repeated resolution with the old version conflicts: list again to inspect the actual outcome, never infer retry from an uncertain HTTP reply. An explicit retry may be dispatched by the normal sweep once the session is ready.

### Retention and retry window

Per session, retain at most the most recent 100 terminal records with full content/payload for UI/API history, and at most the most recent 1,000 terminal records within seven days as compact tombstones. Identical acknowledgement retries remain idempotent for a retained tombstone (content may be empty); older/evicted IDs return 404, which does not prove work was never handled. Recovery audit rows retain at most 1,000 records associated with retained items. Pending/unresolved claims are never age-pruned. They can be superseded at the fresh-human inactive-session boundary below. Maintenance runs on queue reads/additions and completion/reordering; unresolved items remain in `queue.prompts` and capacity counts. Dispatched and superseded prompt records follow the same retention policy. Superseded records retain prior delivery evidence and do not become accepted or verified complete. Full database file allocation may remain at its prior high-water mark; retained logical rows/content are bounded.

## Separate durable callback inbox

Continue using `wingman dispatch inbox`, `acknowledge <dispatch-id>`, and `close <dispatch-id>` for supervised-dispatch results. Callback handling invalidates obsolete wake claims and clears stale wake retries. The dispatcher revalidates the exact unresolved fingerprint and wake attempt after readiness and immediately before adapter/network submission. Closing an older callback never closes a later arrival. Wake sending persists a blocked boundary before submission; uncertain wake delivery cannot lease-expire into replay. Existing dispatch inbox inspection/explicit retry controls remain separate from ordinary queue reconciliation. A wake already submitted before handling cannot be unsent; it remains a separate delivery boundary.

## Fresh-human inactive-session boundary (Pete policy, 2026-10-15)

A verified, authorised **new human trigger** for an inactive/stopped/missing bound session, including a live process whose chat is idle and whose adapter confirms readiness, starts from that fresh message. Before creating or resuming its runtime or delivering the trigger, Autopilot:

1. Saves the fresh trigger as a durable instruction floor. Earlier thread messages remain inert history, available for inspection and native conversation continuity.
2. Captures and durably saves a per-session cutoff vector: exact prompt IDs/revisions, arrived callback IDs/terminal fingerprints, wake identity, and accepted publication/Direct Chat turn IDs. Each store also records an idempotent retirement generation keyed by source session and trigger.
3. Supersedes old pending and uncertain claimed prompts, arrived unresolved callback notifications, and obsolete accepted wake/publication observers. Interrupted work need not be proven complete. Worker processes are not cancelled to clear notifications. Callback supersession means **notification retired, worker result unreviewed**, not managerial acceptance or verified success.
4. Resumes/creates the session and delivers only the fresh human instruction(s). Human arrivals during rehydration join the same boundary; post-cutoff prompts and callback arrivals survive, including callbacks from workers that were still running at capture.

The persisted exact-item vector is reused after a crash between store commits; retrying cleanup never widens the captured set. Queue edits after capture also survive by revision. New callback fingerprints cannot be retired as old arrivals. Multiple stop/resume cycles establish independent boundaries, including reusing the same session ID. Cleanup is scoped to the bound session/routing key; unrelated sessions are untouched. Busy or starting runtimes are never cleared. Live idle reactivation uses the same cutoff even when the session ID stays unchanged; it checks adapter readiness and rechecks chat/runtime state after that await. A native recovery event alone repairs bindings; it is not authority to discard work without the new-human boundary.

Retired prompt claims retain `deliveryState`/`deliveryId` evidence (including uncertainty). They cannot release/replay later. Existing active-session uncertain transport still requires exact-claim recovery; it never automatically retries because of timeout. Old accepted wake observers are stopped and late acceptances checked against the saved generation; stale snapshots cannot restore superseded publication records. Once a Tower HTTP publication has already crossed the send boundary, it cannot be recalled. The guards prevent later local publication; they cannot retract a request already accepted by Tower.

The active pending UI uses the existing queue refresh/Dexie path, so explicit consumption and accepted dispatch shrink pending during work and across reload. Supersession is retained as audit, not displayed as handled worker completion. Existing history, owner access and exact self-session broker restrictions remain intact.

## Validation and activation

Focused store/API/CLI/broker/dispatcher tests use disposable queues. Run lifecycle suites from an isolated source copy with empty `data/`: existing module-level singletons otherwise initialise the checkout default storage on import. The optional browser test uses actual Alpine, Dexie/IndexedDB and UI modules with a disposable loopback server:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chromium \
bun test ./scripts/prompt-queue-acknowledge.browser.test.ts
```

`CHROMIUM_EXECUTABLE` is optional when Playwright has its matching browser installed. Existing live queues are never test fixtures.

A running Autopilot server must be restarted by the operator to activate the migration, new API/broker guards and dispatch lifecycle. Reload the browser after activation. Managed agents must not restart the host without explicit operator approval acknowledging interruption of active sessions. No Tower migration or Flight Deck task/chat record is required.
