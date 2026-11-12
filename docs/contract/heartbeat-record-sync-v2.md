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
protocol metadata with BigInt decimal comparisons. A target stays fixed under content writes during its round. Tower may increase
an unfinished target when a strictly newer access revision repairs an authority
gain; notifications may span pages, so that page need not contain the grant.
Targets and through positions cannot regress. Only complete snapshot family traversal, delta handover, successful
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
SQLite's main-database quota defaults to 2 GiB per partition, deriving its page
count from the actual page size. `WINGMAN_HEARTBEAT_CACHE_MAX_BYTES` may explicitly
set 1 MiB through 16 GiB. A bound below the existing allocation is rejected;
SQLite's silent upward adjustment must not masquerade as an enforced bound.
WAL/temp files need additional disk headroom. Storage exhaustion fails the page
transaction and reports incomplete coverage with allocation/free/limit diagnostics,
without deleting rows or pending intent. Retained generations require a separately
reviewed archival/retirement policy; this release does not purge them. Source CLI
and collector invocations apply the policy on their next open, including legacy
256 MiB caches; no server restart is needed for those source processes.

## Bounds and observation

The entire decoded JSON response is bounded before parsing to 1,048,576 bytes.
Pages allow at most 200 total changes, actors and access notifications. A full-body
page deadline is 30 seconds, clipped to the 120-second wake. New pages start only
with at least 30 seconds remaining. At most two transient retries use full jitter
with a 500 ms base/5 second cap. Retry-After defers to a later wake when a full
retry cannot fit. Signing and selected host transport requests share the deadline.
Redirects and transport fallback are forbidden.

Sync certification is separately reported as `syncComplete`. Dedicated source
`--catch-up` resumes bounded wakes without assembling summaries and stops on
certification, a blocker or its explicit wake cap. See [source commands](../heartbeat-wake.md).

Review assembly reads indexed recent records plus older active tasks, emits at
most 200 summaries/256 KiB per page, and returns durable indexed continuation.
The pinned time window/checkpoint and opaque SQLite-backed position survive
process restart. Continuation uses `--review-only --review-cursor <nextCursor>`,
performs no sync advancement and rejects changed checkpoint/authority. Pages use
keyset ordering across the disjoint older-active/recent phases. Iterator statements
are finalized even on truncation; only the current bounded summary page is held
in memory. Tokens retain positions, never duplicate histories. Coverage includes
selected total/cumulative delivered counts, which do not assert human inspection.
`complete` also requires full summary delivery and available authority. Cached
review identifies its authority observation explicitly and is not a new live poll.
Summary excerpts are explicitly excerpts; canonical cache rows stay intact. Use authorized bounded
record-specific reads for full review detail. No raw pages or duplicate merged
whole histories are returned. Timings separate signing/transport preparation,
headers, body, parse, local commit and ack. The host supplies separate selected-transport headers/body timing; timingScope
identifies host versus client observation. These timings do not isolate remote
server query time. Diagnostics omit signatures,
capability tokens, cursor contents, canonical content and full signed URLs.

When discovery advertises `chunked_v1` alongside the bounded extension, the client
repeats `large_records=chunked_v1` on every page. Standalone manifests are checked
for identity, digest, exact chunk geometry and an explicit 64 MiB assembled-record
resource ceiling. Each raw response remains bounded to 256 KiB; ordinary JSON
pages remain bounded to 1 MiB. A larger manifest fails clearly without advancing.
SQLite stages the page and individual chunks under the prior committed cursor.
Budget/rate-limit interruptions resume the same manifest and skip durable chunks.
The client verifies byte length and SHA256 before decoding UTF-8 across chunk
boundaries, validates canonical identity/sidecars, and commits the row, actors,
cursor, receipt and pending ack intent atomically. Retries use the same durable
receipts, including after a process restart. Staging never certifies delivery.

If first ack rejects a changed source or revoked partition, an atomic before-image
restores the prior cursor and canonical rows. Rejected canonical envelopes and
partial downloads remain archived outside authorized review; they are not evidence
of current authority. Transient/uncertain ack failures retain the committed page
and exact receipts for idempotent retry. Storage exhaustion rolls back the relevant
transaction; it never permits skipping a row. The existing cache quota applies to
staging, before-images and retained rejected downloads as well as canonical rows.
Unnegotiated manifests still fail closed. No Tower or shared-contract change is
required for this consumer.

## Source validation versus activation

Direct `bun clis/heartbeat-wake.ts --smoke`, focused Bun tests and type checks run
new source without restarting Autopilot. A real bound CLI uses the running
Autopilot broker: new source alone cannot load its `record_sync_request` action,
service discovery signing target, or schedule prompt changes into that host.

If the required broker/Tower support is missing, an operator outside managed
sessions must activate accepted Tower support and load accepted Autopilot host
code through an explicitly approved restart. An already compatible running broker
needs no restart for source CLI review/catch-up changes. Issue/reissue appropriately scoped capabilities
that allow GET of the exact `/api/v4/flightdeck-pg/service` path and the bound
workspace v2 register/page/checkpoint/ack routes, preserving FIPS assignments and
transport selection. Do not replace scoped policies with broad authority.

The existing heartbeat schedule must use the v5 prompt (including the
`indexed review continuation v1` marker, shorter sync budget and page-draining
instructions), retain its correct
workspace/app/bot/subscription context, and share the durable cache location
across wakes. Startup reconciliation updates the configured job only when
`WINGMAN_HEARTBEAT_JOB_ID`, `WINGMAN_AUTOPILOT_ROOT`,
`WINGMAN_HEARTBEAT_WORKSPACE` and `WINGMAN_HEARTBEAT_APP_NPUB` are set; otherwise
an authorized scheduler edit is needed. No schedule was activated by this change.
Validate signed discovery and a disposable cache bootstrap/ack/reopen on the
selected transport, then a single supervised schedule wake before wider rollout.
Source fixtures are not live service or production p95 acceptance.

## Explicit finite-host chunk transport

The default `--large-record-transport bounded` uses `record_sync_request` throughout.
Older hosts may lack its exact chunk route and receipt-body allowlists. An explicit
`--large-record-transport host-finite` selects the existing `transport_prepare` and
`transport_request` capability **only** for chunks and receipt acknowledgements.
The source client applies the exact v2 workspace route/method and receipt schema
before calling that capability, bounds its base64 envelope and decoded bytes, and
keeps the same broker identity, exact signed URL/body and selected HTTPS/FIPS
transport. It never retries a denied bounded operation using a different mode.
Ordinary pages/discovery continue through the bounded transport. Missing capability
or transport authority remains a blocker; there is no direct public-network or key
fallback. This explicit source option can run on an already compatible finite-host
broker without restart. Loading the new default bounded host allowlists remains a
separate activation action requiring operator authorization.
