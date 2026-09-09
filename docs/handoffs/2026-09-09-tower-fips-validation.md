# Tower FIPS implementation validation

Worker handoff for task `1da9bddc-a57b-423a-848e-5676b8f9ef68`. Tower retains authority; Autopilot owns transport and runtime. No live host restart, production transport switch, key export, Git push or Tower source edit occurred. Task remains `in_progress` for Rick's review.

## Delivered behavior

Durable HTTPS/FIPS selection preserves existing connection/subscription IDs and cursors. FIPS-only connections require an approved mesh endpoint and separate verified Tower service identity, with no public URL prerequisite or fallback. Exact-target capability-broker signing, mandatory kind33358 messages, bounded verification/streams, explicit session bindings and selected-transport CLI/MCP/storage keep the complete PG dispatch path on that route. Settings expose Apply, Test connection, selected/effective transport, identity, timestamps, reconnect state and counters.

See [rollout and dependency inventory](2026-09-09-tower-fips-rollout.md). Legacy Yoke and unrelated graph/WApps/Forgejo/OIDC/relay integrations are not claimed migrated.

## Reproduce

From `/Users/mini/code/wm/flightdeck`, with Node22, Bun, Docker Linux TUN/NET_ADMIN and Chromium:

```sh
node node_modules/playwright/cli.js install chromium
node --test scripts/release-test/*-check.mjs
node scripts/release-test/run.mjs run --https
node scripts/release-test/run.mjs run --fips --faults
```

This machine's verified Node22 executable is `/tmp/fips-node22/node-v22.21.1-darwin-arm64/bin/node`; use it in place of `node` if the shell resolves an unsupported/broken installation. The harness builds fresh source, pins real Linux mesh binaries, generates private disposable identities, runs isolated services and removes owned resources. Prerequisite, assertion, evidence and cleanup failures exit nonzero. Do not run a live-host restart script.

## Native validation

- `bun run typecheck`: pass, `/tmp/fips-verification-deadline-final-typecheck.log`.
- Isolated source copy `/tmp/tower-fips-bounded-final`: `bun test src/agent-chat src/flightdeck-pg src/mcp/wingman-api.test.ts src/mcp/tower-response-bytes.test.ts src/server/agent-chat-routes.test.ts src/server/static-routes.test.ts src/sessions/session-metadata.test.ts`: **540 pass, 19 skip, 0 fail**, 58 files, `/tmp/fips-bounded-final-broad.log`.
- Transport regressions: **15 pass**, `/tmp/fips-verification-deadline-final-test.log`, including cancellation that never settles and subsequent verification recovery.
- Node harness checks: **12 pass**, `/tmp/fips-final-harness-checks3.log`.
- Flight Deck broader suite: **3715 pass, 1 skip, 3 fail**, `/tmp/fips-fd-broad.log`. Existing attachment attribute assertion, materialization timeout and inbox-history timing failure; focused inbox recheck11 pass. No Flight Deck app source changed. Public-source check has existing documentation findings, none in this harness/docs change. These failures remain reported, not relabeled passed.

## Evidence interpretation

The complete passing matrix `fd-release-1788969177803-d7ef0bc0` includes zero observed public Tower requests during strictly measured FIPS phases using independent namespace firewall and source-filtered ingress evidence plus host counters. The positive control observes blocked packets before reset. Explicit HTTPS rollback is outside those FIPS-only intervals. Browser network access is measured separately from Autopilot. Hard bidirectional peer outage retains an independent successful public HTTPS canary. The transparent mesh proxy records established SSE loss before polling and a committed response dropped before an idempotent replay of the same durable reply.

A/B visible reload history remains exactly five messages; persisted signed records are independently verified and compared with Tower. Attachment bytes, authenticated ACL revocation/restoration, precise target/body/method/query failures, document conflict preservation, task operations, fresh work after owned restart, and held accepted work across transport switch are covered. Exactly five total dispatches includes the three additional continuity roots in separate threads.

Rick reviewed the passing matrix and samples throughout both recordings and privately published [User A](storage://7365ac26-ae52-4f62-a599-07e75bfbe545) and [User B](storage://8b832ed5-f037-4565-b601-3aee25e3c333). His task comment confirms authenticated download hashes and anonymous401. Never publish identities, TLS private keys, Compose secrets or browser profiles. Whole run directories are not safe publication bundles.

The next two runs (`04b7ccd7`, TLS `1fb31014`) failed an additional signature test's presentation read path. Smaller read-only saved-profile inspection proved identical valid persisted records; the corrected oracle reads only the exact workspace IndexedDB store. Original visible reload assertions were unchanged. Their failed manifests remain failed. The separate known member reload defect remains unresolved; this task does not claim to fix it.

## Final source confirmation

Trusted HTTPS baseline `fd-release-1788970343793-9661e8f7`: **passed**, automatic cleanup confirmed. Manifest and A/B videos are under `/Users/mini/code/wm/flightdeck/test-results/release/fd-release-1788970343793-9661e8f7/`. This includes the corrected cryptographic browser-record check and owned runtime restart. Local log: `/tmp/fips-final-https2.log`.

The tested snapshots record:

| Component | Source SHA256 | Build image |
| --- | --- | --- |
| Autopilot | `aef71bfbbb5530ed532df34072b50cc6d10506fa842efcac577760e1d96076a6` | `sha256:4e3de30466cafa9f7082d7b59ed90e4293618deddd94cc37c837cd6036be4be7` |
| Flight Deck | `8a9784a1bad1c710911d83be5a02eccb9e14c011468042eae1052232d4ed6684` | Frontend built and served by harness; manifest records build metadata |
| Tower | `509a442c915e3d3c35647f6fc6b1829dd364bbdb30868162dd2d51acb4f4e171` | `sha256:a6408ea0c8545791f6599cede31fe146425e5aa1027959c9c23661fadddd32ed` |

Snapshots include current concurrent Tower source, explicitly listed in manifests; this worker made no Tower edit. App source snapshot hashes exclude documentation. Harness scripts are committed separately. Manager reviewed the existing compatible `docs/imp/two-user-release-test-handoff.md` and requested preserving it in a separate documentation commit; its text is unchanged.

Final full FIPS confirmation `fd-release-1788970342283-a94d8915`: **passed, cleanup true, process exit0**. Its source/build hashes match the table above. Root evidence directory: `/Users/mini/code/wm/flightdeck/test-results/release/fd-release-1788970342283-a94d8915/`.

- Manifest: `manifest.json`; browser report: `browser/report.json`.
- A recording: `browser/6884f328d4a2e56d709dfa9915894d92.webm` (11,828,740 bytes).
- B recording: `browser/f3d2be103db24a7847134962ae04cc6f.webm` (11,367,128 bytes).
- Worker visually inspected both195s video frames: matching complete five-message histories. This is sampled inspection, not a claim to have watched every frame. Manager reviewed broader samples of the previous full passing recordings linked above.
- `fips-network-assertions.json`: both independent counters0 packets/0 bytes; scoped TLS ingress unchanged22; HTTPS requests0; selected/effective FIPS, verified service, final reconnect state connected.
- `fips-fault-assertions.json`: actual dropped committed reply `58f9d61e-30d8-4273-af61-9c901007333c`; same-key same-record replay; 55.437s bidirectional outage with37 outgoing/71 incoming dropped packets and fresh degraded runtime timestamp; independent public canary passed. Full ordered ledger and precise negative statuses included.
- `fips-continuity.json`: stable subscription `e4a63388-d94c-4229-9fad-22793d1741d7`, connection `fa1f1c59-6a70-4bc5-8b9f-d001d44ae3a1`; all three fresh roots/replies/session IDs/signatures, nonregressing cursors and exactly five dispatches.
- `tower-fips-settings.json`: actual Test, draft persistence and Apply checks. Screenshot records the immediate post-Apply transient aborted stream; final network diagnostics above confirm connected recovery. It is not presented as a healthy-state screenshot.

## Local commits and activation

Autopilot:

- `0cafe194997c0f5456352553ec8efd52611907a1` — Add approved Tower FIPS transport and connection controls
- `607d05c` — Scope Tower requests to durable session transport bindings
- `2223b358b663561e693d34b7919989c07468b5db` — Preserve canonical document bases and mesh attachment routes
- `e4fb60579c514ce50e232db193a5e8d955be8843` — Validate mesh probes and restore recovered stream health
- `1e432cb23c4caf441a305fafa1aaafb190863f9b` — Bound shared Tower identity verification deadlines
- `539d259` — Exercise held turns and unlinked mesh attachments

Flight Deck: `49d7879` — test: add isolated Tower FIPS acceptance matrix. Harness/docs only; no application release metadata bump or unrelated source modification.

Documentation is committed separately as `Record Tower FIPS acceptance and restart handoff`. No pushes. Implementation and local acceptance are complete; handoff remains with Rick. Pete can then restart the live Autopilot externally for staged testing using the rollout instructions. Existing broker capabilities must be reissued normally if their exact-target policy changes. The worker has not activated this code in Pete's live control process.
