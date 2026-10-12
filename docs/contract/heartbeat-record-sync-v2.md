# Heartbeat record-sync v2

The Bun source CLI `clis/heartbeat-wake.ts` consumes Tower record-sync v2, never
legacy bundled `/sync`. Discovery must advertise device checkpoints, additive
access and `retain_downloaded`. Every local cache has a random nonzero UUID,
partitioned by Tower endpoint/workspace/app/viewer; the UUID lives with its rows.
Cache loss requires a fresh identity and snapshot. Server checkpoints cannot
restore missing local records.

The CLI negotiates `extension=bounded_snapshot_v1` when advertised by
`record_sync.extensions`, repeating it on every page. It validates Tower's
handover target/through position, authority epoch and access revision as opaque
protocol metadata with BigInt decimal comparisons. A target cannot change during
its round. Only complete snapshot family traversal, delta handover, successful
local materialization/ack and a valid terminal certificate permit `complete=true`.
Unextended v2 can make durable progress but always reports incomplete certification.
A negotiated error never falls back to legacy sync or another transport.

Tower owns authority and the certified committed journal prefix. Autopilot owns
this heartbeat cache. Flight Deck's TowerSyncService remains the browser's sole
network/materialization owner feeding Dexie/liveQuery; heartbeat does not own or
reuse a browser checkpoint. Declared coverage is exactly advertised families.
Directory, approvals, graph and WApp activity require separately authorized APIs.

## Commit, recovery and retention

Bun-native SQLite uses WAL and FULL synchronous transactions. Canonical rows,
BigInt versions/tombstones, actors, access changes, generation, cursor and pending
ack intent commit together. An ack uses the exact serialized `{cursor,
expected_revision}` body only after commit; registration hashes the empty body.
On restart, pending ack is attempted before dependent paging. Lost ack responses
retry idempotently. Conflict reconciliation reads registration but retains the
local committed cursor, then replays from that position with a fresh issuance
revision; it never substitutes server-only rows/cursors.

One durable lease owns writes for a wake plus 30 seconds. Every mutation checks
the lease token, expiry, generation/client and expected local cursor. Failed or
stale responses never advance local state. Replacement generations retain old
rows and pending intents with repair/conflict status. Workspace membership loss
stops reads/acks and makes evidence unavailable. Lost family/resource partitions
remain downloaded but are excluded from review; omission never means deletion.

The cache defaults to `data/heartbeat-record-sync/`, relative to the source repo,
with private file/directory permissions. `WINGMAN_HEARTBEAT_CACHE_DIR` or
`--cache-dir` chooses another durable location. Keep it on local persistent
storage supporting SQLite locking; do not copy a live cursor without its rows.
SQLite's page-count quota is 65,536 pages (normally 256 MiB). Storage exhaustion
fails the page transaction and reports incomplete coverage, without deleting rows
or pending intent. Retained generations may eventually need an explicit retention
policy; this release does not purge them.

## Bounds and observation

The entire decoded JSON response is bounded before parsing to 1,048,576 bytes.
Pages allow at most 200 total changes, actors and access notifications. A full-body
page deadline is 30 seconds, clipped to the 120-second wake. New pages start only
with at least 30 seconds remaining. At most two transient retries use full jitter
with a 500 ms base/5 second cap. Retry-After defers to a later wake when a full
retry cannot fit. Signing and selected host transport requests share the deadline.
Redirects and transport fallback are forbidden.

Review assembly reads indexed recent records plus older active tasks, emits at
most 200 summaries/256 KiB, and marks truncation incomplete. Summary excerpts are
explicit excerpts; canonical cache rows stay intact. Use authorized bounded
record-specific reads for full review detail. No raw pages or duplicate merged
whole histories are returned. Timings separate signing/transport preparation,
headers, body, parse, local commit and ack. The host supplies separate selected-transport headers/body timing; timingScope
identifies host versus client observation. These timings do not isolate remote
server query time. Diagnostics omit signatures,
capability tokens, cursor contents, canonical content and full signed URLs.

Individually oversized rows/actors fail closed on Tower's 413 without advancement.
This client does **not** negotiate `chunked_v1`. A manifest received without
negotiation is an error. Complete traversal of legal records above 1 MiB needs a
separately reviewed chunk consumer; ordinary bounded bundles are supported now.

## Source validation versus activation

Direct `bun clis/heartbeat-wake.ts --smoke`, focused Bun tests and type checks run
new source without restarting Autopilot. A real bound CLI uses the running
Autopilot broker: new source alone cannot load its `record_sync_request` action,
service discovery signing target, or schedule prompt changes into that host.

After review, an operator outside managed sessions must activate accepted Tower
support at the selected endpoint and load accepted Autopilot host code through an
explicitly approved restart. Then issue/reissue appropriately scoped capabilities
that allow GET of the exact `/api/v4/flightdeck-pg/service` path and the bound
workspace v2 register/page/checkpoint/ack routes, preserving FIPS assignments and
transport selection. Do not replace scoped policies with broad authority.

The existing heartbeat schedule must use the v4 prompt (including the
`record-sync v2` marker and incomplete-result instructions), retain its correct
workspace/app/bot/subscription context, and share the durable cache location
across wakes. Startup reconciliation updates the configured job only when
`WINGMAN_HEARTBEAT_JOB_ID`, `WINGMAN_AUTOPILOT_ROOT`,
`WINGMAN_HEARTBEAT_WORKSPACE` and `WINGMAN_HEARTBEAT_APP_NPUB` are set; otherwise
an authorized scheduler edit is needed. No schedule was activated by this change.
Validate signed discovery and a disposable cache bootstrap/ack/reopen on the
selected transport, then a single supervised schedule wake before wider rollout.
Source fixtures are not live service or production p95 acceptance.
