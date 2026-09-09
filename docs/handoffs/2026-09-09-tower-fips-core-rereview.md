# Corrected Tower FIPS core — independent re-review

For manager `408e11dc-9c04-4c0b-b0db-930984b3301a`; worker `8a8256f3-b51f-472b-949e-85c15d4abfdf` remains active. **Corrections are substantial, but core routing still has concrete defects. No overall delivery approval.**

Reviewed HEAD `0cafe194997c0f5456352553ec8efd52611907a1` plus the current uncommitted corrections. Read the implementation brief, progress, prior seven findings, review briefs, all 26 tracked file diffs and all five new source/test/script files. Used the platform skill and repository instructions. At `2026-09-09T14:24:41Z`, HEAD remained unchanged; `git diff HEAD --binary` SHA-256 was `a408565a361abfc986a00e5a739e8765e2888f7d5e17c6f4283562ce2f92ddbd` (457 additions, 159 deletions). References below are to this worktree, not just HEAD. The worker can change it after this snapshot.

Final verification: HEAD was still unchanged. The implementation brief gained a concurrent manager note at 14:27 UTC acknowledging the dispatch binding and SSE cleanup defects; I read that addition. The hash above identifies the earlier reviewed snapshot, before this documentation-only addition.

Only this handoff was written. No shared runtime/harness commands, grants, secret reads/exports, implementation edits, commits, pushes or external posts. Independently ran only `bun test src/agent-chat/tower-event-stream.test.ts` (2 pass, 0 fail) and an in-memory SSE cleanup reproduction described below. The stream module's Tower client import is type-only; these checks do not initialize host stores or contact Tower. Other reported tests are worker evidence, not independent reruns.

The user's latest run status supersedes the progress file's earlier “building” text: `fd-release-1788963477368-b0258abd` passed browser conversation/reload/owned restart but **FAILED no-egress**, with five blocked public Tower attempts. I did not inspect or rerun that harness, attribute its five attempts, or accept it.

## Prioritized remaining findings

### 1. P1 — Dispatch channel-context hydration still bypasses the selected connection

`src/agent-chat/dispatch-pipelines/runtime.ts:954` calls `fetchFlightDeckPgScopeChannels` with URL/workspace/scope/app/bot, but omits both `backendConnectionId` and `subscriptionId`, even though `input.subscription` is available. `tower-client.ts:755` passes that absent context into signing and fetching. `tower-transport-runtime.ts:31` returns no transport for an ordinary public URL with no connection context, and line 50 directly calls `fetch(input, init)`.

**Source-proven trigger:** a dispatch requiring Tower channel context on a connection migrated from public HTTPS to FIPS. This call signs and sends to the old public URL, outside host transport counters and without the adapter's redirect restriction. With an originally FIPS-only logical URL, it instead fails “no approved Tower connection.” This is an actual unmigrated PG consumer, not merely a missing test. It is not demonstrated to explain the five attempts in the reported run.

Carry the subscription's connection context through this call and audit remaining context-free PG callers. Add a focused migrated-connection dispatch regression asserting no ordinary fetch. The new optional-context API must not make a forgotten required binding silently behave as public HTTPS.

### 2. P1 — Direct-session CLI/MCP connection resolution still selects the first matching subscription across owners/connections

`subscription-runtime.ts:1364` (`resolveFlightDeckTurnDelivery`) searches `store.listAll().find(...)` by active lifecycle, Tower service, workspace and bot only. It now returns that record's connection ID. The subscription uniqueness index includes connection and manager (`workspace-subscription-store.ts:695`), so the same service/workspace/bot tuple is not a globally unique subscription key.

`mcp/wingman-api.ts:1233` resolves direct context with this tuple, without passing the session owner or originating subscription/connection. Direct-session creation (`direct-chat-runtime.ts:729`) records the tuple and routing key but no exact subscription/connection binding. The new host transport actions use the resulting subscription (`wingman-api.ts:1393`), and ordinary MCP actions use its connection ID.

**Source-proven ambiguity:** with two matching active subscriptions on different connections, the second session can use the first connection's endpoint, mode and diagnostics. This can select HTTPS despite the originating connection selecting FIPS. A matching subscription on a different owner is not excluded. This is a transport-approval/owner-isolation defect; it is **not evidence of a Tower ACL bypass, stolen signature or arbitrary bot impersonation**. Normal session-capability admission remains at `server/api-routes.ts:654`, and the helper requires the resolved bot's valid signature.

Bind direct sessions to their authorized subscription/connection and validate owner/delegation on resolution. Do not resolve an ambiguous tuple by array order. Test two connections with the same tuple and differing modes, including differing managers, and confirm only the initiating connection is used.

### 3. P2 — SSE application errors abandon a live stream without cancelling it

`tower-event-stream.ts:17` throws on `flightdeck_pg.error`, JSON failure, or a delivery exception. `sse-events.ts:10` obtains a reader but has no `finally` cancelling/releasing it. `subscription-runtime.ts:3890` catches the failure and proceeds to polling, then opens another SSE connection. The subscription's signal remains active. The transport intentionally clears its deadline after SSE headers (`tower-transport.ts:135`).

**Independently reproduced without network:** a `ReadableStream` enqueued `event: flightdeck_pg.error\ndata: {}\n\n` and stayed open. After `consumeTowerEventStream` rejected, its underlying cancel callback had not run and `stream.locked` was true. Output: `{"error":"Tower reported an event stream error","cancelled":false,"locked":true}`. Therefore a server-side error that leaves the connection open, or a local delivery failure, can retain old sockets/readers while recovery opens more. Ordinary EOF is a different case.

Give each stream attempt explicit cancellation/reader cleanup in `finally`, including handler errors, before polling/reconnect. Add the error-with-open-stream regression. This is distinct from proving a lost-message or duplicate-dispatch bug, neither of which was reproduced.

### 4. P2 — “Finite” host transport helper accepts unbounded SSE and only checks response size after buffering

`mcp/flightdeck-transport-helper.ts:13` accepts every descendant of the bound workspace, including `/events/stream`. It forwards caller headers unchanged, then awaits `response.arrayBuffer()` (line 33) and checks the 32 MiB limit only after allocation. An authorized caller can request the existing stream route with `Accept: text/event-stream`; the transport removes its body deadline, so the helper waits for the endless response and can accumulate stream bytes. `remote-tower-transport.ts` does not pass cancellation into the broker call, and the host helper does not connect request cancellation to Tower.

This is a source-demonstrated resource-bound gap in a newly exposed helper, not proof that the normal CLI currently requests SSE or that memory exhaustion occurred. Restrict the finite helper to finite responses/routes, bound bytes while reading, cancel excess/error responses and propagate cancellation. Streaming would need a separate streaming contract. A post-buffer length check is not a memory bound.

## Disposition of the original seven findings

| Prior finding | Current source disposition |
| --- | --- |
| 1. Global origin lookup | **Original implementation removed; incomplete end-to-end fix.** Adapter lookup is by explicit connection/subscription; equal-origin records no longer collide there. Remaining caller omission and direct tuple resolution are findings 1–2 above. IDs alone are routing context, not independent owner authorization. |
| 2. Disabled/revoked/legacy reconnect | **Resolved for the reported steady-state switch cases.** Settings skips disabled/revoked records, attempts every active reconnect and reports failures. Runtime reconnect uses guarded `ensureConnected`, restoring PG-versus-legacy dispatch. Runtime checks both flags; revoked state is also checked by `ensureConnected`. No independent concurrent disable/revoke-during-drain proof. |
| 3. Public health bypass | **Resolved in source for the reported path.** `tower-client.ts:2253` uses connection-specific transport by default and constructs `/health` for FIPS instead of depending on retained public health configuration. Redirect rejection applies through the adapter. No runtime health/no-egress acceptance claimed. |
| 4. Dormant SSE | **Resolved for FIPS activation, with cleanup defect above.** `runFlightDeckPgEventLoop` now invokes one sequential stream consumer in FIPS mode and polls its durable cursor after failure/closure. HTTPS retains its existing polling behavior. Established SSE, forced loss and exactly-once recovery still need live evidence. |
| 5. Stale callbacks on switch | **Reported switch race materially addressed by draining.** Runtime stops receipt, awaits the accepted per-subscription event queue before saving transport, and checks generation again before final poll cursor/health writes. Accepted durable work may complete on the old route before switching; this is an explicit drain, not stale-callback rejection. No lost-response/idempotency or concurrent lifecycle-operation acceptance inferred. |
| 6. CLI local DB/counters | **Resolved for a correctly bound broker CLI; incomplete coverage.** CLI with subscription context installs `remoteTowerTransport`; prepare/sign/send goes through the host and its counters, removing child-local lookup on this branch. Contextless broker CLI still chooses the old direct path, and direct-session binding has finding 2. Source-label hydration now reads transport config from its supplied database and constructs/closes a local adapter; it intentionally still has separate telemetry. A real child-process broker test remains required. |
| 7. Lost drafts/foreign-owner controls | **Original timer-refresh loss and ownership presentation addressed in source.** Nonsecret drafts persist in Dexie and are reloaded into refresh/cached snapshots; successful save deletes them. Model checks API `operator.canManageAvailability`, which compares actual manager to viewer, and combines it with management permission. Browser interaction evidence remains outstanding. |

## Additional boundaries and residual claims

- Source-label hydration reads the supplied DB's transport side table rather than the module-global host DB (`flightdeck-dispatch-source-loader.ts:140`). Legacy absence normalizes to HTTPS. This fixes the original DB-context defect. It does not make that maintenance process's local counters host telemetry or prove live switch coordination for a separate process.
- Host helper preparation maps to an approved connection origin before broker signing. Request validation verifies the signature, resolved bot pubkey, timestamp, exact `u`, method and hash of supplied bytes. Native transport pins the mesh address and rejects mismatched Host; both selected transports reject redirects. No automatic fallback exists inside `TowerTransport`. These properties do not cover context-free calls in finding 1.
- Helper validation does not explicitly require event kind 27235 or check a payload tag when the body is absent; `/api/v4/storage/` is allowed without local object/workspace resolution. These are narrower local validation guarantees than a full NIP-98/workspace policy. Tower must still enforce NIP-98 and object ACLs. I did not demonstrate a downstream acceptance bypass and do not report one as proven. Exact negative signing and storage ACL tests remain necessary.
- The host proxy is a generic signed-request transport, not a new signer. Existing capability signing and kind-33358 paths remain; no raw-key broker workaround was introduced. Capability admission alone does not repair the connection-selection ambiguity above.
- FIPS has no stream inactivity watchdog here: the PG watchdog is deliberately started only for non-FIPS. A stream that stays open but ceases producing bytes will not reach poll recovery until the underlying transport errors. A real blackhole/fault test must establish the required recovery behavior; a forced clean close proves only the close path.
- UI `transportAction` refreshes while `busy` is true, then clears `busy` without a rerender (`workspace-settings-section.js:101–118`). A successful action can leave controls disabled until the next timer refresh. This is a small source-visible UI regression, separate from the fixed draft-retention issue.
- Pre-existing legacy record/group/key/registration helpers and HTTPS presigned downloads still have direct network dependencies. Full first-release no-egress and attachment coverage cannot be inferred from selected adapter counters. The failed real-mesh run remains failed.

## Snapshot and manager callback

New source/script file SHA-256 values at the snapshot:

```text
675123aff08c9cdaffc3f3f1ab4813f5b2414367bd73ebaa6469bec443ecd919 scripts/isolated-test/admin-cookie.ts
c39c5a65676f8b1a2a89bec838be00f3917c5e29e5b295996b860d48c4dbb43a src/agent-chat/tower-event-stream.test.ts
6587512158ff8422482030a1f9eaad736f9efa6ae7b5e2b1f8c84a014964c333 src/agent-chat/tower-event-stream.ts
3c813d9a2c70af104ed26acc2241a4370ab17ebed062721d1c1dd01afe1e5e59 src/flightdeck-pg/remote-tower-transport.ts
bcc295bd37625ded5b86f03ef042d13ef2361cc181d1ac4e5f77442aab5dcbe7 src/mcp/flightdeck-transport-helper.ts
```

Manager: prioritize the omitted dispatch connection binding and ambiguous direct-session connection resolution, then stream cleanup and finite-helper resource bounds. Two isolated SSE tests pass; the cleanup counterexample reproduces. Network/fault/negative/attachment/video evidence and the five blocked public attempts still require separate review. No restart readiness or final delivery approval is given. No commit was made, per the read-only review instruction.
