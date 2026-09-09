# Final Tower FIPS source and acceptance audit — 2026-09-09

For manager `408e11dc-9c04-4c0b-b0db-930984b3301a`, worker `8a8256f3-b51f-472b-949e-85c15d4abfdf`, task `1da9bddc-a57b-423a-848e-5676b8f9ef68`.

**Verdict: do not approve overall acceptance or restart readiness.** The reported core routing/resource defects have substantial, source-verifiable corrections, and 20 independently executed isolated checks pass. The named final run **failed**, and the harness still omits required restart/switch and negative cases. This is not evidence that the transport universally fails; it is a failed acceptance run plus specific coverage gaps.

Read the implementation handoff, acceptance/core/core-rereview reports, progress and final brief; inspected current source, commits and harness. Applied the Wingman platform skill. No host/default DB access, stack operations, external posts, credentials, identity files, browser profiles, runtime restarts, commits or pushes. Only this report was written. Tests below use pure modules or ephemeral loopback fixtures with injected mesh resolution, not host stores or the native daemon.

## Snapshot and actual run result

Autopilot HEAD `2223b358b663561e693d34b7919989c07468b5db` (`Preserve canonical document bases and mesh attachment routes`), following `607d05c` and `0cafe19`. Reviewed the additional uncommitted subscription SSE health change and isolated-test scripts. Flight Deck HEAD `d04784bc713077dc74b6ef8c5eb6ad7214b34c33`, with modified browser/run/runtime scripts and six new FIPS modules. Tower HEAD `7ba83369c36d2a0934304aaf7e823fd71f4f6d00`; its snapshot includes unrelated WApp changes, not reviewed as part of FIPS.

Run `fd-release-1788966065458-8e7366c1` completed at `2026-09-09T15:04:22.650Z` with `status: failed`, `cleanedUp: true`. Failure: `B continuing thread and second reply: Timed out: runtime explicitly unhealthy during mesh outage (90000ms)`. Its browser report confirms only the initial live root/first reply assertions before that failure. Two nonempty A/B videos were finalized; their existence does not make the scenario pass. I inspected their report metadata, not video content.

The run did **not** reach final A/B attachment download, full signed-history verification, fault/network final assertions, settings verification or restart acceptance. Its mesh interface/routes/peer evidence records connected UDP peers and active TUN; its TLS baseline and FIPS Test connection succeeded. The public internet canary succeeded during outage. Those are useful partial results, not a no-egress/outage-recovery pass. No final `fips-network-assertions.json` or `fips-fault-assertions.json` was present when checked.

The earlier `fd-release-1788965713949-7ba50de0` also remains **failed**: browser conversation/reload assertions completed, then the attachment download timed out. Its top-level signature verifier was not reached. Do not convert those browser assertions into a completed signed-history acceptance result. Earlier five-packet runs likewise remain failed; the supplied FIN/ACK diagnosis explains the new measurement boundary, not a retroactive pass.

Named run source hashes from its manifest:

| Component | sourceSha256 |
| --- | --- |
| Autopilot | `3de186ff93c186a33b6584691165a027d836c07f1285f88af26fd2d0a4c063af` |
| Flight Deck | `eeb50899c3e37f03a2a3e22b3752462fe5414f31c2e19221be19155339a73986` |
| Tower | `509a442c915e3d3c35647f6fc6b1829dd364bbdb30868162dd2d51acb4f4e171` |

Autopilot image `sha256:799627339b93071d564f94b9b6f364dd1249d77c702eb21c908294fffd685ad7`; Tower image `sha256:a6408ea0c8545791f6599cede31fe146425e5aa1027959c9c23661fadddd32ed`. Manifest SHA-256 at inspection: `49a1fef93df2c1e46b1e0823b547b6829040c18eb32c42c41b00e98a28fe47da`.

Concurrent edits continued during review: current Flight Deck run/browser/faults files differ from the named run's source snapshot. In particular, terminal fault-evidence capture was added afterward. References below describe inspected current source unless explicitly identifying the run. Do not attribute those later edits to its built/tested image.

At final read, the worker updated progress: a new run `fd-release-1788966389782-942e2f5b` is underway, and the fault now blocks both UDP directions instead of only outgoing traffic. **That new run's evidence is pending and was not audited.** The worker also reports a final broad run with 538 passes, 19 skips and one startup-readiness timeout, followed by a passing focused recheck; the broad run itself remains failed. These updates do not change the named run's failed verdict or the harness coverage findings.

## Prioritized remaining findings

### P1 — Final outage/recovery acceptance failed; cause remains unproven

`flightdeck/scripts/release-test/browser.mjs:283–292` requires a newly dated poll failure and nonhealthy subscription before restoring mesh, then requires the waiting follow-up to complete. The named run timed out at that first requirement. Source has a 45-second stream idle deadline (`tower-transport.ts:137–153`), followed by reconciliation/verification and polling before the outer loop records `lastEventPollErrorAt` (`subscription-runtime.ts:3893–3975`). The stream catch itself only saves `sseStatus = backoff`; it does not immediately recompute health or record the failure timestamp.

The isolated idle-socket test passes, so a timer unit result cannot establish which part of that live sequence failed. Diagnose from safe terminal state/ledger and distinguish delayed/error reporting from an actual live socket or recovery failure. Do not simply remove the new-failure requirement or accept an old degraded status. A fresh clean run must complete outage, waiting-message recovery, attachments, no-egress, signatures and cleanup. This audit does not claim a reproduced root cause for the timeout.

### P1 — Restart and transport-switch continuity remain untested

`flightdeck/scripts/release-test/run.mjs:211–223` restarts the owned Autopilot, waits for subscription health, checks the bot and rechecks the **same two** outcomes and old history. It submits no fresh work after restart, does not directly compare the persisted cursor/connection across restart, and closes browser recordings before this phase. A subscriber unable to dispatch new work could pass those assertions.

`fips-runtime.mjs:25–41` performs the initial HTTPS-to-FIPS switch before the conversation. `fips-settings.mjs:39–45` reapplies the existing FIPS configuration. Neither exercises FIPS-to-HTTPS rollback and back, nor switches with an established stream and accepted/in-flight work. Add separately counted fresh post-restart work and a controlled switch-continuity phase, preserving the original exact two-turn conversation assertions. Unit drain/generation tests are useful but do not fill this live acceptance requirement.

### P2 — SSE assertions can pass without proving the first established stream was lost

`fips-faults.mjs:35–39` enables denial/destruction; `fips-fault-proxy.mjs:11–19,45–49` can destroy active streams and logs forwarded requests. But `verifyMeshFaults` (`fips-faults.mjs:60–68`) only requires some `sse-denied` record and some successful `/events?` request. It does not require an earlier successful stream, a recorded closure of that stream, or ordering/cursor association between closure, poll and fresh mention. Starting entirely with denied SSE can satisfy this verifier.

The later browser health check at `browser.mjs:268–271` precedes the UDP outage, not the initial forced-stream-loss phase. Runtime also marks `connected` before entering its inner stream loop (`subscription-runtime.ts:3855–3865`), so status alone is weaker than an established-stream ledger entry. Require the successful stream/closure and ordered poll evidence. The real mesh proxy is a suitable observer; no replacement event dispatcher is needed.

### P2 — Negative coverage is narrower than the labels and prior acceptance requirements

`scripts/isolated-test/fips-client-probe.ts:36–63` exercises a brokered workspace read, an unapproved public origin, wrong expected service, an outsider, a changed query and altered body bytes. However:

- `rejects()` accepts **any exception**, so network failure could satisfy `incorrectService` or `unapprovedDestination`; check the expected error and absence of a protected operation.
- Outsider workspace access accepts either 401 or 403. A malformed/rejected authentication could satisfy the ACL assertion without proving a correctly authenticated outsider was denied authorization. Require the actual ACL denial code/status.
- There is no separate changed-method case, reordered-query case, wrong approved mesh node/port, forged forwarding-header/wrong-Host case, or storage metadata/content ACL denial and revocation/incomplete-object case. The changed `?tampered=1` request is genuine exact-query-target coverage, but does not cover all those cases.
- Document/task happy-path operations exist at lines 76–91; there is no concurrent document-conflict acceptance test or task-state update in this probe. Do not label it full document concurrency or task lifecycle coverage.

Narrowly add the required security cases; unrelated graph, Forgejo, WApps and OIDC migration remains out of scope. The tests must distinguish host broker denial from Tower validation/ACL denial and verify durable state remains unchanged after rejected mutations.

### P2 — New terminal-evidence failure can skip cleanup

Added during review, after the named run: `run.mjs:231` awaits `captureFipsFaultEvidence` before closing the frontend and invoking `cleanupRun`. That helper catches command failures, but its `privateJson` write (`fips-faults.mjs:100`) can throw. A report-write failure then exits the `finally` before owned cleanup and final manifest persistence. Keep cleanup in an unconditional nested `finally`, while preserving the evidence failure/nonzero exit. Existing `finalize.mjs:42–50` correctly makes actual cleanup failures fail the manifest; it cannot help if never reached. No runtime reproduction was attempted.

## Resolved prior source findings and limits

| Prior issue | Current disposition and evidence |
| --- | --- |
| Global origin/owner mixing | Explicit ID resolution in `tower-request-context.ts:9–23` and `tower-transport-runtime.ts:20–39`; conflicting IDs/missing records fail. Direct metadata stores subscription/connection (`direct-chat-runtime.ts:730`); resolver filters owner, service, workspace, bot and explicit IDs, rejecting ambiguous legacy tuples (`flightdeck-session-transport.ts:25–33`). Independent owner/ambiguity test passes. |
| Omitted dispatch binding | `dispatch-pipelines/runtime.ts:954` now passes subscription/connection. Inspected publisher, direct/task/document hydration, activity, delivery and CLI/MCP callers carry their binding or the bound identity transport. No additional current omitted required caller was found in this trace; this is not an exhaustive proof of every optional future caller. Contextless public operator calls still exist by design and must not be counted as migrated bound calls. |
| Nested document/storage binding | Both document create/update uploads now forward IDs (`tower-client.ts:1357–1361,1489–1495`). Storage prepare/upload/complete stay in shared transport. Brokered document attachment selection prepares the permitted content route (`flightdeck-pg/client.ts:785–790`), avoiding the forbidden root-origin probe and public presigned URL in FIPS. |
| Disabled/revoked/legacy reconnect | Settings skips disabled/revoked subscriptions and attempts each active reconnect (`tower-connection-settings.ts:43–55`); runtime reconnect uses guarded `ensureConnected` (`subscription-runtime.ts:1438–1453`). Accepted queued work is drained before config changes. Concurrent lifecycle changes during draining were not independently exercised. |
| Public health bypass | `tower-client.ts:2260` onward selects `transportForConnection(record)` and mesh health rather than retained public health URL. |
| Dormant SSE and abandoned parser | FIPS event loop now actually consumes SSE then polls. Parser `finally` cancels/releases (`sse-events.ts:71–73`); open application-error regression passes. Silent native SSE fails under idle deadline; separate verification callers can cancel independently. |
| Unbounded finite helper | `flightdeck-transport-helper.ts:11–12,25–45` rejects stream routes/Accept and returned SSE, validates kind/actor/target/method/body/forwarding headers and caps input. `tower-response-bytes.ts:6–15` enforces output bytes incrementally and cancels/releases. Remote fetch cancellation reaches host request and Tower. Preparation has its own bounded verification rather than caller cancellation. |
| CLI/local DB and counters | Bound remote CLI uses host prepare/sign/send (`remote-tower-transport.ts:8–29`). Probe invokes the actual CLI binary (`fips-client-probe.ts:14`) with inherited capability context. Source-label maintenance uses its specified read-only DB and a locally constructed/closed adapter (`flightdeck-dispatch-source-loader.ts:32–67`); its counters remain local. |
| Draft loss/ownership/busy controls | Dexie draft restoration and actual ownership gating remain; `workspace-settings-section.js:117` rerenders after clearing busy, resolving the rereview's disabled-controls issue. New settings browser test exists but was not reached by the named run. |

## Document concurrency assessment

`flightdeck-document-base.ts:3–9` uses Tower's canonical version ID and stored body hash, validates their row version/storage object against the returned document, and fails if unavailable/inconsistent. It does not compute a hash of the replacement text and call that the base. CLI `client.ts:414–422` and MCP `wingman-api.ts:1450–1478` read the authoritative document, retain that row/base through lease acquisition, then send them unchanged with the body update. The newly uploaded bytes retain connection context.

Tower locks the canonical head and checks row version/version ID/body hash (`tower/src/services/flightdeck-pg-api.ts:3971–4000`); stale bodies create a non-head recovery instead of replacing canonical content. Autopilot throws non-2xx errors with parsed status/detail information (`tower-client.ts:574–606,1532–1536`), with no automatic reread/rebase retry. Thus a concurrent change **after the helper's read** is not silently accepted by this fix. The helper obtains the current base when update is invoked; it does not establish that a caller's previously edited local body was based on that version. No broader stale-editor guarantee is claimed. The independent base test passes; an end-to-end conflicting save/recovery preservation test remains absent.

## Harness evidence meaning

- **Real transport/full authority:** `fips-mesh.mjs:45–116` provisions TUN/NET_ADMIN, joins each application to its daemon namespace, connects UDP peers and enables full Tower mesh ingress. Mesh node/service identities are explicitly distinct. Production native request derives/pins the node address while preserving Host/path/query/body (`native-fips-request.ts:17–87`). The transparent fault proxy forwards original bytes/headers to that real listener; it does not synthesize Tower success or signatures.
- **Broker/model boundary:** real ProcessManager/turn publication remain. The deterministic ACP executable now launches the child CLI probe before supplying its deterministic text (`deterministic-acp.ts:25–36`). This is additional test-driving behavior, not literally output-only; the child uses the real broker and production client, not a replacement dispatcher or borrowed human signer. If “only deterministic output” is enforced literally, move probe scheduling outside the model executable. The outsider key is disposable negative-test material, not the bot signing path.
- **TLS/network:** `fips-tls.mjs` provisions a run-owned certificate/trust file and normal verified HTTPS. `fips-runtime.mjs:44–58` restarts only the owned TLS listener to retire baseline sockets, verifies no established runtime-to-Tower sockets, then installs/reset counters. Named drain evidence contains one baseline `:3443` socket and no established sockets afterward. No FIPS stream or daemon is deliberately closed there. `socketsAfter` is a literal empty field after a successful predicate, not a raw full socket-state capture.
- **Independent no-attempt proof:** namespace nft rules cover the Tower IPv4 TCP destination and ordinary listener ports off TUN; measured counters must be exactly zero, and TLS ingress is source-filtered. Positive-control evidence records one blocked packet before reset. Code checks curl rejection but does not itself assert positive-control counter increment; require that too for a robust oracle. This proves the fixture's listed routes, not arbitrary future public aliases. Host transport counters reset with transport/process lifetime, so they cannot replace the independent namespace evidence across restart. Named run never reached the final zero-counter assertion.
- **Committed lost reply:** proxy records the actual successful Tower response before destroying downstream (`fips-fault-proxy.mjs:30–43`); verifier requires exactly one dropped durable message and a replay with the same request key/record ID. Correctly permits renewed NIP-98 signatures. This is stronger than replaying an acknowledged human root, but its final verifier was not reached in this run.
- **Attachments/history:** browser code attaches the object through A's normal signed metadata edit, preserving existing body/signature (`browser.mjs:341–351`), then reloads and downloads under both browser identities with byte hashes (`361–384`). It calls the application's download method, not a visible attachment-button click. `verify.mjs:14–28` checks kind 33358, author, body/hash and routing of durable records. Both paths are meaningful; neither completed in the named run. No direct Dexie insertion or signing bypass was found in this fixture change.
- **Privacy/finalization:** private run directory/umask, reviewed public fields, source/build hashes and distinct A/B recording finalization remain. Do not share whole run directories; videos were not visually reviewed here. Original cleanup failure handling is sound, with the new pre-cleanup evidence-write exception above. Named failed run reports successful cleanup.

## Independent validation and remaining handoff

Executed `bun test src/agent-chat/tower-event-stream.test.ts src/agent-chat/flightdeck-session-transport.test.ts src/agent-chat/flightdeck-document-base.test.ts src/mcp/tower-response-bytes.test.ts`: **6 pass, 0 fail**. Executed `bun test src/agent-chat/tower-transport.test.ts`: **14 pass, 0 fail**, including exact encoded target/bytes, redirects, cancellation and idle deadline. These tests cannot prove real mesh or full dispatch. Broad suites/typecheck in progress are worker-reported results and were not independently rerun against the default DB.

The worker can now test the corrected core and documented `node scripts/release-test/run.mjs run --fips --faults` in their owned stack. Remaining: explain/fix the failed outage observation, strengthen the specific assertions above, add fresh restart/switch and required negative coverage, complete a fresh final run and private evidence review, and commit the final tested harness/source under normal repository rules. No unrelated integration migration is requested. No overall task approval or live-host restart recommendation is issued. This audit made no commit, as explicitly required.
