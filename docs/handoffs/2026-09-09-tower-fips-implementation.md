# Autopilot Tower FIPS implementation — authorized 2026-09-09

Pete has started this task. Ignore the historical 'do not implement until started' status below: his current instruction is to review the task/doc, set a goal and manage implementation to completion with video evidence in the local test setup, then tell him it is ready for an Autopilot restart for testing.

You are the supervised implementation worker. Implement and validate the entire task. Set your session goal and nextAction reflect; do not stop at a plan. Manager Rick will perform separate review. Do not spawn additional workers unless you coordinate first with manager.

Primary workdir /Users/mini/code/wm/autopilot, main. Authorized secondary scope /Users/mini/code/wm/flightdeck/scripts/release-test and its docs for the required FIPS acceptance scenario; Tower /Users/mini/code/wm/tower only for proven ingress gaps. Read AGENTS.md in every repo before edits. Preserve all concurrent work; commit all nonignored tested state except secrets/evidence unsafe for publication. Autopilot repo forbids Git push: commit locally, no push. Never restart/stop/replace the LIVE HOST Autopilot; Pete will restart after handoff. Isolated owned Docker test-stack starts/stops/restarts and fault injection are authorized, as is building source. Never disrupt Pete's active control channel. Use capability broker for stable bot signing; no secret search/export or raw-key workaround. Disposable generated test identities inside the isolated harness are expected; never publish identity files/browser profiles.

Read latest architecture scene (currently local v5; resolve again), including nested scene data and relationships. /Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v5/excalidraw-scene.json. Apply Tower-authority / Autopilot-runtime boundary; flag substantive design conflicts to manager.

## Routing and reporting
Manager re-review 14:27 UTC: read docs/handoffs/2026-09-09-tower-fips-core-rereview.md when available. New confirmed dispatch channel-context hydration lacks connection binding and can public-fetch migrated FIPS origin; SSE Tower error event leaves stream locked/uncancelled (isolated reproduction). Fix before final acceptance. These are separate from FIN/ACK measurement boundary.
Manager core review 13:55 UTC: blocking findings on 0cafe19: origin-only global connection lookup mixes owner scopes/diagnostics; transport setting updates reconnect disabled subscriptions; backend health direct fetch bypasses adapter; reviewer tracing PG SSE loop with no caller versus polling-only delivery. Read docs/handoffs/2026-09-09-tower-fips-core-review.md and latest task comments before final acceptance, fix confirmed findings.
Manager acceptance review 13:44 UTC: reviewer found cached pinned Linux FIPS 0.5.0 archive at /Users/mini/code/wm/wmapp/app/linux/.fips-cache/fips-0.5.0-linux-x86_64.tar.gz, checksum matches repository pin. Current isolated image lacks FIPS/TUN. Tower Docker seam fixture is TCP forwarding, not mesh proof. Read docs/handoffs/2026-09-09-tower-fips-acceptance-review.md when available; scope independent network counters to Autopilot, not browser Tower calls.
Manager verified live context: Tower URL https://sb4.otherstuff.studio, app npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5. Use explicit --tower-url and --app-npub with workspace for CLI. If worker capability still denies access, proceed from complete source snapshots; manager has fetched task/doc/comments and will post progress from local handoff file. Do not grind on missing inherited context.
Workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9; scope 76d518f7-c477-4374-bf74-5d36fda570ed; channel 6c89191a-69d6-460a-97d3-f937bd40cfeb; thread e6e824df-f435-45fe-9f98-961463728d4e; trigger f337abff-f1d6-47f8-9186-232d2bd843fd; task 1da9bddc-a57b-423a-848e-5676b8f9ef68; plan ac8f5e41-4001-4d20-a30b-4f54e40fed47. Tower service npub1vf3h0rmlrr0x6pjc68jcrk5p2zsfzl3f9zwcppcdn8386npdlxgqmam99v. Manager session 408e11dc-9c04-4c0b-b0db-930984b3301a. Use explicit workspace CLI routes if inherited MCP task context is unavailable. Read latest task/comments before implementation and handoff; manager's execution contract is instructions, not a self-dispatch to skip. Post meaningful technical milestones and final evidence on task only; Rick owns chat progress and final. Leave task in_progress for manager review.

Required local durable progress file docs/handoffs/2026-09-09-tower-fips-progress.md. Update at investigation, core implementation, validation and terminal handoff. Include exact commands/results, changes, commits, blockers, videos/report paths, runnable setup instructions, and remaining runtime activation. Produce separate A/B recordings and real mesh/network proof; mock/socket-only passes are insufficient. Any twice-repeated blocker: report exact evidence and pivot to smaller verifiable step rather than grind. Never weaken reload assertion or mark failing end-to-end runs passed. Continue until all acceptance is met or an evidenced external blocker prevents progress.

## Full authoritative task at intake
Status: New; prepared for Pete to kick off in this Autopilot thread. Do not dispatch or implement until he starts it.

Source: @[Pete’s handoff request](mention:message:5f942047-f32d-4d58-8b46-1c6d9e46be7d). Design: @[Autopilot → Tower FIPS implementation plan](mention:document:ac8f5e41-4001-4d20-a30b-4f54e40fed47). Read the latest plan and task comments before implementation.

Outcome: Autopilot connects to Tower using its service identity and approved FIPS endpoint, with no public Tower URL prerequisite and no automatic HTTPS fallback. Preserve the existing workspace, connection/subscription IDs, cursors, stable bot signing, permissions and duplicate-dispatch protection. WM App is not a runtime dependency.

Implement in five ordered steps:
1. Add per-Tower HTTPS/FIPS configuration and migrate existing connections without changing HTTPS behavior. Distinguish mesh node identity from Tower service identity; verify the expected service before use.
2. Reuse Autopilot’s native FIPS runtime in a shared request/stream adapter. Preserve exact method, path, query, body, headers, cancellation and timeouts. Sign the actual approved target through the capability broker; retain mandatory kind-33358 chat signatures. Reject redirects or destinations outside approval.
3. Route the complete Agent Direct / Flight Deck PG exchange through it: SSE, recovery polling, context, claims/acknowledgements, activity, final replies, associated CLI/MCP, task/document operations and attachments. Cancel obsolete streams on switching; retain idempotency across lost responses. Inventory any remaining public dependencies explicitly.
4. Add transport selection and Test connection to existing Tower settings. Show selected/effective transport, verified identity, last successful request/event, reconnect state and per-transport request/error counters.
5. Add repeatable automated acceptance scripts and document rollout/rollback. Discovery remains deferred; unrelated graph/WApps/Forgejo/OIDC migration is outside this first release.

Primary repo: /Users/mini/code/wm/autopilot. Starting points: src/agent-chat/backend-connection-store.ts, workspace-subscription-store.ts, types.ts, tower-client.ts; src/flightdeck-pg/client.ts; direct-chat-tower-hydration.ts; flightdeck-dispatch-source-loader.ts; src/apps/native-fips-runtime.ts. The plan identifies adapter and migration details. Tower /Users/mini/code/wm/tower is a contract reference unless a demonstrated ingress gap requires a change. Resolve the latest Wingman Suite architecture board before implementation.

Automated testing reference: @[Two-user automated testing scripts and results](mention:message:6fa37925-3554-47ec-84fe-fb20f91e917a); @[Two-user Playwright test plan](mention:document:698246cd-9b30-4af9-9eba-80698b57c6bb); @[Existing release-test harness](mention:task:bdb6f02d-09aa-4e07-b14d-b877f3b518a0).
Reuse /Users/mini/code/wm/flightdeck/docs/two-user-release-test.md and scripts/release-test/{run,stack,runtime,browser,browser-api,verify,finalize}.mjs. Existing commands, from that repo:
  node node_modules/playwright/cli.js install chromium
  node --test scripts/release-test/*-check.mjs
  node scripts/release-test/run.mjs run
Use Node 22 LTS, Bun and Docker as documented. The harness builds fresh Tower/Autopilot/Flight Deck source, generates disposable test identities/workspace, runs two independent browser profiles, exercises real dispatch/broker signing, records both users and cleans up owned resources. Only model output is deterministic.

Required NEW test work: extend that harness with a documented FIPS scenario/command (not currently implemented), using real isolated mesh peers and the production Autopilot transport. First establish HTTPS baseline, then configure FIPS with no public URL and enforce public Tower egress blocking on the test Autopilot. Assert zero public Tower requests using independent network/ingress evidence plus transport counters. A’s mention must produce one run/reply, B sees it live and follows up in the same session; both retain identical signed history after reload. Cover SSE interruption and FIPS recovery polling, FIPS outage with public internet still available, recovery/restart/switch without lost messages or duplicate runs, ambiguous write response retries, attachment access, incorrect Tower identity, denied workspace access, unapproved destinations and exact NIP-98 body/target failures. Also add focused Bun transport/connection regression tests and run bun run typecheck plus the appropriate broader bun test suite.

Evidence: one runnable command per scenario, nonzero exit on prerequisites/assertions/cleanup failure, source/build hashes, network assertions, signed-record/dispatch IDs, report/manifest and separate A/B recordings. Publish only reviewed evidence privately; never upload test identity files or browser profiles. A mock-only transport test or health response is not proof of a real FIPS exchange.

Known existing test issue: @[Intermittent member-channel reload defect](mention:task:78672320-5665-4e77-8e4f-74f3197df82e). Recent harness runs included two passes and an intermittent failure. Recheck current status before running; preserve the reload assertion and report any recurrence separately, never weaken it or label a failing end-to-end run passed.

Execution after Pete starts: delegate a focused worker in the target repo; keep task comments and this new thread updated. Default main, preserve concurrent changes and commit all nonignored tested state except material unsafe for publication. Report hashes, test results and exact activation status. Do not disrupt the host Autopilot without Pete’s explicit approval; fault injection/restart tests target only the isolated test stack. Move to review after validated handoff.


## Full plan at intake
# Autopilot → Tower over FIPS: implementation plan

Status: proposed implementation plan; no worker dispatch or runtime change authorized by this planning request.

Origin: @[Plan request](mention:message:047b0f33-28de-4a52-a907-573d0d090029), following @[Working Flight Deck FIPS trial](mention:message:65f0062f-90d8-4a80-8ade-b94729e93d01).

## Outcome and boundaries

Autopilot connects to a Tower by service identity and manually approved FIPS endpoint. Public HTTPS is optional. Agent Direct receives events, hydrates context, dispatches once, and publishes activity/results entirely through the selected transport. Selecting FIPS must never silently fall back to public HTTPS.

First release covers the complete Agent Direct / Flight Deck PG path, including associated CLI/MCP operations and attachments used by that path. Other Tower integrations (graph, unrelated WApps, Forgejo/OIDC) are inventoried and explicitly reported; do not claim all Autopilot traffic uses FIPS until migrated. No discovery server, new WebSocket protocol, or duplicate event dispatcher.

Primary repo: /Users/mini/code/wm/autopilot. Tower /Users/mini/code/wm/tower is a contract reference; change it only for a demonstrated ingress gap. WM App is not a runtime dependency for this server-side connection. Reuse Autopilot's existing FIPS runtime.

Architecture reference: latest locally published board currently v5, /Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v5/excalidraw-scene.json. Resolve latest before implementation. Tower owns authority/shared state; Autopilot owns subscriptions/dispatch/runtime. Preserve stable actor, workspace and subscription IDs.

## 1. Connection model and migration

Inspect src/agent-chat/backend-connection-store.ts, workspace-subscription-store.ts and types.ts. Add a transport configuration associated with the existing Tower connection: mode HTTPS/FIPS, expected Tower service npub, exact mesh endpoint and optional HTTPS endpoint. Keep stable connection IDs, existing cursors and dispatch state independent of transport.

Migrate existing connections to HTTPS without changing behavior. Permit a new FIPS connection without inventing a public hostname. Bind operator approval to Tower identity and exact endpoint; mesh node npub and Tower service npub are separate identities. Validate endpoint syntax/port and verify service identity over FIPS.

Acceptance: old connections still load; FIPS-only config persists/reloads with no HTTPS endpoint; mismatch rejected; changing transport retains subscriptions and cursor state.

## 2. Shared native transport and signing

Implement a reusable Tower request adapter, proposed src/agent-chat/tower-transport.ts. Inspect src/apps/native-fips-runtime.ts for lifecycle/readiness and existing addressing utilities. Choose the supported Bun socket/dispatcher mechanism during a small transport spike; do not assume ordinary DNS resolves .fips.

Resolve/pin the mesh destination, preserve HTTP method/path/query/body, response status/headers, streaming, aborts and timeouts. Reject redirects and requests outside the approved destination. Resolve the actual endpoint before NIP-98 signing; broker capability checks must authorize that exact target. Preserve kind33358 chat instruction signatures and existing ACL/delegation semantics. No raw-key workarounds or global signing grants.

Acceptance: real local socket fixture verifies exact signed target/body, streaming cancellation and bounded errors; public HTTPS unavailable does not affect FIPS; mesh failure produces an explicit error and zero public retries.

Depends on step1.

## 3. Migrate the complete dispatch path

Start with src/agent-chat/tower-client.ts (currently has direct fetch calls, signed requests, /events and /events/stream), src/flightdeck-pg/client.ts, direct-chat-tower-hydration.ts and flightdeck-dispatch-source-loader.ts. Trace callers for SSE, recovery polling, context reads, claims/acknowledgements, activity, final replies, task/document operations and attachment access. Route each through the same connection selection.

Retain existing SSE parser, durable cursor and dispatch deduplication. Recovery polling must use the selected FIPS route too. Preserve storage authorization; any externally presigned storage URL is an explicit dependency to resolve or report, not evidence of FIPS-only operation.

On transport change, cancel old streams/requests, start one new subscription generation, and reject stale callbacks. Do not automatically replay an ambiguous write without its existing idempotency protection.

Acceptance: one test mention produces one run and one final reply; disconnect during receipt/publication then reconnect causes neither lost durable work nor duplicate dispatch.

Depends on step2.

## 4. Controls and connection evidence

Extend the existing Tower connection settings and status API/CLI; identify the exact UI handlers before editing. Add HTTPS/FIPS selection, endpoint, verified service identity and Test connection. Switching should affect only that Tower's subscriptions.

Show selected and effective transport separately, last successful request/event, reconnect state and a clear failure reason. Add per-transport request/error counters useful for proving the route. Never log signatures, capability tokens or sensitive request bodies.

Acceptance: Test connection performs mesh health plus an authorized workspace read; unavailable FIPS is visibly unhealthy, never shown as working HTTPS. Existing HTTPS users remain unchanged.

Depends on steps1–3.

## 5. Acceptance and rollout

Run focused native repository tests, bun run typecheck, then the appropriate broader bun test suite; report baseline failures separately.

Required integration matrix:
- HTTPS baseline, then FIPS with public Tower HTTP(S) blocked.
- Signed context read, message publication, activity and final result; one dispatch.
- Wrong service identity, unauthorized workspace and unapproved destination rejected.
- SSE interruption, cursor recovery, polling recovery, restart and transport switch; no duplicate run.
- Lost write response retried safely using existing idempotency keys.
- Attachment read/write dependency checked explicitly.
- Diagnostics show FIPS requests and zero HTTPS Tower requests.

Test fault injection in an isolated fixture/connection, never by disrupting Pete's active control channel. Stage a test workspace/agent first, then enable the production connection. Rollback is explicit HTTPS selection where configured, preserving connection IDs/cursors. A FIPS-only deployment remains disconnected if mesh access fails.

Commit tested source on main while preserving concurrent changes; use repo release rules. Do not restart the Autopilot process without Pete's explicit approval. Complete code, tests and a concrete rollout handoff before that final restart step.

Suggested delivery order: steps1–2 as the first checkpoint, step3 as the second, steps4–5 as final acceptance. Each checkpoint should report commits, tests, remaining consumers and exact live activation status. Discovery remains a separate later task.
