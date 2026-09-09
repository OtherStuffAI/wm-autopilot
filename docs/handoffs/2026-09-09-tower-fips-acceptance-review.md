# Independent FIPS acceptance design review — 2026-09-09

For manager `408e11dc-9c04-4c0b-b0db-930984b3301a`, implementation worker `8a8256f3-b51f-472b-949e-85c15d4abfdf`.

Initial, source-only review. Feasible with the locally available real Linux FIPS distribution, but **the existing release harness is not a real-mesh acceptance scenario**. No stack, test, network probe, signing operation, grant change or runtime restart was performed. No credentials were read. Only this findings file was written; no commit/push. Worker changes were appearing during inspection, so this is acceptance design guidance, not final implementation approval.

Read the complete implementation brief and progress file, root instructions in Autopilot/Tower/Flight Deck, the platform skill, Tower ingress/gateway contracts and fixtures, and release-test runner/stack/runtime/browser/signature/finalization code. Observed HEADs: Autopilot `82df1df`, Tower `7ba8336`, Flight Deck `d04784b`; these do not identify the worker's uncommitted changes. Progress still stated implementation/validation pending at inspection.

## Prioritized findings

### P0 — Prove real mesh before extending the browser scenario

`scripts/isolated-test/Dockerfile` has no FIPS executable or TUN bootstrap; Flight Deck `scripts/release-test/runtime.mjs:addRuntime` supplies neither `/dev/net/tun` nor `NET_ADMIN`. Autopilot's production `Dockerfile:16–35,167–169` already provides checksum-pinned Linux FIPS 0.5.0 binaries; production `docker-compose.yml` supplies the device/capability. Reuse those distribution inputs, but do not run the production Compose project.

`src/apps/native-fips-runtime.ts:inspectNativeFipsRuntime` is macOS-specific: launchctl and an attestation requiring the public bootstrap. The emerging worker `native-fips-request.ts` now has a Linux control-socket readiness branch; verify that branch against a real daemon, not an injected command runner. Linux setup must make the control socket accessible to the runtime user, and the TUN interface must exist in the application's network namespace. A sidecar on an ordinary shared bridge does not provide another container's TUN route.

Tower's `tests/fixtures/fips-docker-seam.ts` listens on `::1`, uses a fixed 43101 Docker forward, and signs an authenticated echo. `fips-docker-ingress.ts` calls `verifyNip98Auth`, not the full Tower app/database. They are useful TCP/HTTP contract fixtures, **not real mesh, ACL, dispatch, or storage proof**. Do not use their fixed host port while the managed gateway may own it.

Acceptance must show production Autopilot request code -> its FIPS IPv6/TUN -> real daemon UDP peer exchange -> Tower's mesh interface -> `createFipsIngressFetch` -> real Hono/PG. Record daemon versions, public node identities/derived addresses, healthy peer evidence and interface/route evidence alongside signed application outcomes. Merely assigning an fd IPv6 address or forwarding TCP across the Docker bridge is insufficient.

### P0 — Zero public Tower traffic needs independent, correctly scoped evidence

The current runner uses `http://tower:3100` inside Docker and loopback HTTP outside (`stack.mjs:towerCompose`, `runtime.mjs:connectRuntime`). It is a public-listener baseline, **not TLS HTTPS acceptance**, despite transport mode naming. Add a run-owned TLS front door if claiming the required HTTPS baseline; use disposable trust material and normal certificate verification.

The browsers and verifier legitimately use Tower's public listener. A total Tower ingress count cannot establish that Autopilot used no public route. Capture/filter by Autopilot's namespace/source and phase. Block every ordinary Tower destination reachable by that runtime (Docker service/IP, public front door, alternate IPv4/IPv6/host routes) while allowing peer UDP and required independent services. Ensure the dedicated Docker ingress cannot be reached directly as a mesh bypass.

Retain independent packet/flow or firewall-log evidence plus ordinary-ingress observations and adapter counters. Distinguish zero successful public requests from zero attempted fallback: blocked connection attempts must also fail the no-fallback assertion. Include a positive-control blocked probe outside the measured window to prove the filter works, and a permitted non-Tower reachability probe during mesh outage. A network-wide disconnection cannot prove that fallback stays disabled while public internet is available. Label a local egress canary honestly if actual internet availability is not demonstrated.

Capture metadata only, or keep any full packet captures private: cleartext HTTP over TUN includes authorization headers and application bodies. Published manifests must omit tokens, signatures-as-authorization, presigned query strings and identity files.

### P0 — A successful read/health check does not prove the broker or authority boundaries

Tower `src/server.ts:32` health exposes `service_npub`; ingress authenticates the mesh node at the transport layer and canonicalizes the HTTP Host separately. Require the expected **Tower service** identity to differ from the **mesh node** identity in the fixture. Wrong expected service must reject before workspace use, including after restart or changed endpoint; do not describe unsigned health alone as a cryptographic service-identity challenge.

Preserve the harness's dedicated bot, real ProcessManager, normal turn bridge and capability broker; only ACP output may remain deterministic. `src/signing/fips-signing-policy.test.ts` demonstrates that mesh targets need exact origin/path/method/assignment permissions and that changing policy does not widen an already-issued capability: explicit reissue is required. Isolated setup must exercise normal test-owned policy provisioning/reissue, not inject an all-target broker or lend a human key to the agent. This reviewer performed neither action.

Test separately: broker denial of another node/port/path/workspace; Tower ACL denial for a correctly signed but unauthorized actor; and Tower 401 for a valid signature over the wrong body, method, ordered query or origin. A broker 403 does not prove Tower body verification. Include HTTPS-signed request on mesh with forged forwarding headers and wrong Host (421). Recheck durable state is unchanged after each mutation failure. Existing `verify.mjs` tests tampered body and root replay through the host HTTP API, not the production mesh path. Default port 80 is accepted canonically by Tower but deliberately rejected by current signing policy; do not choose it for this fixture.

### P1 — Existing offline/restart/replay checks miss the hard failure windows

`browser.mjs:291–317` tests **browser B offline**, not Autopilot SSE outage. `run.mjs:173–183` restarts Autopilot after both videos have closed. `verify.mjs:31–43` retries an acknowledged human root, not an ambiguously acknowledged agent publication.

Add these distinct phases with explicit deadlines and before/after IDs/cursors:

1. Drop only the established Autopilot SSE connection while ordinary mesh GET remains usable. Publish a fresh mention; prove recovery polling goes over mesh and dispatches exactly once. Keep SSE unavailable long enough to prove polling delivered it, rather than merely a quick SSE reconnect.
2. Interrupt the peer link with a mention waiting, keep non-Tower egress available, assert visible FIPS failure and zero public attempts; restore and require durable recovery without missing/duplicate triggers.
3. Let Tower commit an agent write, then suppress the response in a run-owned fault fixture on the real mesh path. Retry the same logical idempotency key with fresh valid NIP-98 auth. Prove one durable reply and one dispatch; do not merely reject before commit.
4. Restart only the run-owned Autopilot with persistent bot/node/state volumes. Verify the same connection/subscription/workspace IDs, bot identity, cursor continuity and outcomes; send fresh work after recovery so retained old history cannot mask a dead subscriber.
5. Switch HTTPS -> FIPS -> explicit HTTPS rollback (where configured), with an old stream and in-flight work. Prove cancellation, one active subscription generation, stale callback rejection and no duplicate dispatch. FIPS-only configuration must persist/reload with no invented public URL and remain disconnected during outage. Do not confuse the harness's `WAPP_TOWER_URL` boot prerequisite with an allowed hidden Tower fallback.

Fault fixtures must remain byte-transparent observers/fault injectors around the actual mesh exchange, never replace the production transport or dispatcher. Preserve the original two-human-turn/same-session case; isolate extra fault-trigger messages or explicitly extend the expected IDs/counts instead of relaxing exact-count assertions.

### P1 — Attachments can escape mesh or become unreachable despite passing chat

Tower `src/routes/storage.ts:24–55,168–228` returns presigned S3 URLs and also provides authenticated content routes. Its ingress intentionally does not rewrite external storage URLs. Autopilot `src/flightdeck-pg/client.ts:740–799` can follow `download_url` through `fetchImpl`, separate from signed content access. Inventory this path, upload preparation/bytes/completion, task/document attachments and context hydration.

Current MinIO config advertises `http://storage:9000` (`stack.mjs`), which is usable inside Docker but not normally resolvable by the host browsers. A backend-only object creation is not browser attachment acceptance. Require actual upload, completed object, matching byte hash, authorized bot context access and A/B read after reload; require a separate ungranted actor to fail metadata/content access. Verify permission removal at Tower's authenticated route; do not assume an already-issued presigned URL is immediately revoked. Exercise incomplete/missing objects and unapproved returned destinations without silently falling back.

Choose and document whether bytes use Tower's authenticated mesh content route or an explicitly approved S3 dependency. The latter can support the first-release scope but cannot be labeled all-attachment-bytes-over-FIPS. Never forward Tower authorization to S3 or blindly follow redirects off the approved authority.

### P1 — Keep browser evidence and architecture assertions strong

Reuse separate generated A/B profiles and secret-entry-unrecorded lifecycle. `finalize.mjs` already requires two distinct videos over 1000 bytes and fails on closure/recording errors; preserve it and cleanup failure propagation. Show actual mention, live B response, stable same session, identical durable signed order after both reloads, completed activity, and live offline catch-up before navigation. The known intermittent member-channel reload failure must fail that run and be reported separately, not be hidden by a retry or API-only history assertion.

Latest published local architecture is v5: `.../artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v5/excalidraw-scene.json`, root wrapper `scene` (v1–v5 enumerated; draft not substituted). Inspected nested text, containers and arrow bindings. Tower owns NIP-98-mediated authority/storage/PG; Autopilot runs agents/pipelines/apps; Flight Deck coordinates work. Arrow `fb_XJOvW9UdG1yU-XxvOA` binds TowerSyncService (`7Q2OqGGu6gNXNAa1_zyVG`) to Tower (`7aiZYrsZ70wJjWPI7YaIS`); the detailed panel specifies TowerSyncService -> Dexie -> liveQuery -> Alpine, with SSE/cursor/polling/hydration owned together. No parallel browser synchronizer or injected Dexie/Alpine records should be added for this test. WM App is not a required runtime dependency.

## Reusable distribution and safe setup path

Found and read-only verified:

```
/Users/mini/code/wm/wmapp/app/linux/.fips-cache/fips-0.5.0-linux-x86_64.tar.gz
SHA256 a57240b70d8e0940ba5d962b0b9881cadd2befb43b75991e435d74243cbd7b27
```

It contains `fips`, `fipsctl`, `fips.nft`, sample YAML and installation documentation. Hash matches both Autopilot Dockerfile and `wmapp/tools/prepare_fips_linux.sh`. The latter accepts `--arch x86_64 OUTPUT_DIR` and can consume this cache without downloading when its hash matches. Use a private run-owned output directory; **do not execute install.sh, systemd/launchd helpers or host DNS/firewall setup**. Only x86_64 archive availability was verified; native ARM64 needs the separately pinned archive (`c0e00bd8e9dc0ca01cbd6992da5d3944530a6a18df4e2d36c073b3913488d40f`) or an explicitly recorded/tested amd64 container platform. Emulation and Docker TUN availability were not tested here.

Proposed setup sequence, to implement in the existing runner, not an already verified one-command FIPS fixture:

1. Retain Node 22 enforcement, private run directory, clean Docker client config, current-source snapshots/build hashes and unique Compose ownership from `run.mjs`/`stack.mjs`.
2. Package the verified daemon/CLI into owned Linux peer containers with TUN and scoped NET_ADMIN. Start two persistent, newly generated node identities in private volumes with no peers, read only their public status, then configure each other's public npub and run-network UDP address. Archive sample `peers[].addresses`, `connect_policy: auto_connect` and production YAML provide the syntax. Disable Nostr/LAN discovery, advertisement and public bootstrap for this isolated topology; no host identity reuse.
3. Place the Autopilot app in its peer network namespace (or daemon in its container); place Tower in its peer namespace. Prefer Tower's existing `TOWER_FIPS_INGRESS_MODE=mesh` to bind its derived fd address directly. Wait for active TUN **before** Tower starts: optional ingress bind failure leaves normal Tower health green and does not establish mesh readiness. Keep ordinary Tower reachable for browsers via a separate run-owned published front door, blocked specifically from Autopilot during FIPS phases.
4. Verify real daemon control status and peer connectivity, then signed production-adapter workspace read through full Tower. Only then run the two-user browser flow and failure matrix under independent network observation.
5. Finalize reviewed evidence and remove only this project's resources; every missing prerequisite, assertion or cleanup failure exits nonzero.

Do not reuse `scripts/docker-entrypoint.sh` unmodified for isolated mesh: it runs `ensure-fips-bootstrap.py` against a YAML configuration containing a public bootstrap and enables production rendezvous. Do not copy Tower's documented live `.env.prod`/host gateway activation commands into the release runner.

Currently documented runnable commands remain `node --test scripts/release-test/*-check.mjs` and `node scripts/release-test/run.mjs run` from Flight Deck, plus Tower's socket tests. They were inspected, not executed by this reviewer. No existing complete real-mesh Docker scenario/command was found in the inspected release harness. The worker must supply that command, its verified topology, required HTTPS baseline, network report and separate A/B recordings before acceptance. Host Autopilot activation remains Pete's later restart after manager review.
