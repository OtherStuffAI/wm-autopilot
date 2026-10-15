# Heartbeat record-sync and review

Run the Bun source CLI in an authorized Autopilot agent session with
`WINGMAN_BROKER_URL` (or `WINGMAN_URL`), `SESSION_ID` and `WINGMAN_CAPABILITY`.
The broker supplies agent identity/signing and the authoritative bound
workspace/Tower/app. Unbound sessions require explicit `--workspace`,
`--tower-url` and `--app-npub`; assertions must match any existing binding.
No keys are exported. Selected HTTPS/FIPS transport stays with the host.

## Dedicated bootstrap catch-up

After the existing cache owner has stopped its catch-up, run from the same source
repository with the same bot identity and durable cache directory:

```sh
bun clis/heartbeat-wake.ts --catch-up --hours 12 --max-pages 100 --max-time-ms 120000 --request-timeout-ms 30000 --max-wakes 100 --output tmp/docs/handoffs/heartbeat-catch-up.json
```

This resumes the existing default cache, including pending acknowledgements.
It does not create another client ID, erase the cache or assemble summaries.
Each wake stays within the original 120-second/30-second-page/200-entry/1-MiB
bounds. Progress is durable between wakes and process restarts. The explicit
wake cap is an operational limit, not a completeness claim; rerun to resume.
Do not run against a cache another manager is currently syncing. A writer lease
rejects contention; do not bypass it with a new cache directory or identity.

Catch-up stops on `syncComplete=true`, a genuine sync/authority/protocol/storage
error, or the wake cap. A budget deferral without any page progress stops for
inspection rather than spinning through empty wakes. Retry-After is respected
inside each wake; exhausted transient retries are a blocker, not an endless loop.
Stdout emits compact per-wake progress and a final `certified`, `blocked`, or
`wake_limit` outcome. Exit 0 means sync certified, 1 means blocked/setup/output
failure, and 2 means the wake cap was reached. The output file holds only the
latest wake evidence, so memory and evidence do not accumulate full histories.
Create the operational output directory first and verify it is ignored/untracked.

`syncComplete` means the negotiated `bounded_snapshot_v1` boundary has been
materialized and acknowledged. It does **not** mean the records were reviewed.
`complete` intentionally stays false in catch-up because review was not started.
Unextended v2, revoked authority and oversized records cannot certify absence.

## Normal wake and review continuation

```sh
# A normal wake reserves time for review/reporting with a shorter sync budget:
bun clis/heartbeat-wake.ts --hours 12 --max-time-ms 60000 --max-pages 10 --output tmp/docs/handoffs/heartbeat-review.json
# After catch-up, start review without another sync:
bun clis/heartbeat-wake.ts --review-only --hours 12 --output tmp/docs/handoffs/heartbeat-review.json
# Inspect the emitted page, then pass its review.nextCursor verbatim:
bun clis/heartbeat-wake.ts --review-only --review-cursor <nextCursor> --output tmp/docs/handoffs/heartbeat-review-next.json
```

Add the same explicit targeting flags or `--cache-dir` to every command if the
session requires them. The default cache is `data/heartbeat-record-sync/` under
the source repository, unless `WINGMAN_HEARTBEAT_CACHE_DIR` is set. A different
repository checkout has a different default directory: explicitly select the
existing location when moving the CLI. Cache partitioning also includes
Tower/workspace/app/viewer, so a different bot is a different cache.

Review selects all active tasks plus records updated in the fixed recent window,
with each canonical record included once. Older active tasks come first, then
recent records; both use indexed `(updated,family,id)` keyset ordering. Each
page emits at most 200 summaries/262144 UTF-8 bytes. Canonical histories remain
in the cache; title/body fields are excerpts. Full details require separately
authorized task/thread reads. Directory, approvals, graph and WApp activity are
outside this cache's advertised coverage.

`review.nextCursor` is an opaque token backed by durable SQLite state. Continue
until it is null, inspecting every page. `review.total` is the selected authorized
record count and `review.delivered` is the cumulative summary count through that
position; delivery is not inspection. Neither a 200-row sample nor
`syncComplete=true` establishes a completed review. `complete=true` requires
sync certification and complete delivery with no unavailable partitions; the
agent must still inspect the summaries and report detail limits.

Continuation pins the initial `since`, generation, sync cursor, access revision
and authority epoch. `--review-cursor` requires `--review-only`, which performs
broker context/identity checks but no Tower discovery/register/page/ack calls.
It reports `coverage.observation=pinned-cache-review`: authority is the last
successful sync observation, not a fresh Tower poll. Authority filters apply on
every page. A changed checkpoint/authority, new review session or missing token
fails clearly; start a new review and report interrupted coverage. Token replay
returns the same summaries and continuation under the same checkpoint. With a
continuation, `since` is authoritative and `recentTriageHours=null`; a newly
passed `--hours` value does not change the pinned window. There
is one active review session per cache; starting another replaces its tokens.
Store output/token before proceeding, and finish review before the next sync.

Without catch-up, exit 0 means complete summary coverage, 2 means incomplete
sync/review coverage, and 1 means setup/context/output/continuation failure.
`--json` is accepted for compatibility; JSON is always emitted. With `--output`,
stdout contains metadata and the next token; summaries are in the output file.
Without it, stdout contains the entire bounded result. `--hours` only selects
recent review activity; it never filters download coverage.

## Source and runtime activation

```sh
bun clis/heartbeat-wake.ts --smoke
bun test ./src/heartbeat/record-cache-review.test.ts ./src/heartbeat/heartbeat-catch-up.test.ts ./src/heartbeat/heartbeat-review-cli.test.ts
bun run typecheck
```

These commands execute current source without an Autopilot restart. The general
`bun clis/wingman.ts` dispatcher has no heartbeat subcommand; `wingman-cli.js` is
a separate tmux manager. Local installed wrappers may point to older copies and
must not substitute their legacy exit/coverage semantics for this source CLI.

Real source runs still depend on the running broker supporting bound
`record_sync_request`, transport preparation and exact service discovery signing,
scoped capabilities and Tower's accepted bounded snapshot extension. If these are
already active, no host restart is required for the new source CLI flags/review.
If missing, host code must be loaded by an operator outside managed sessions
under explicit restart authorization; source changes cannot activate broker code.

Scheduler prompt v5 adds `indexed review continuation v1`, a 60-second sync
budget and page-draining instructions. Startup reconciliation needs
`WINGMAN_HEARTBEAT_JOB_ID`, `WINGMAN_AUTOPILOT_ROOT`,
`WINGMAN_HEARTBEAT_WORKSPACE` and `WINGMAN_HEARTBEAT_APP_NPUB` and loaded host
code. Alternatively, an authorized scheduler edit can install the generated
prompt while the host remains running. Preserve workspace/app/bot/subscription
context and the shared cache path. Rick owns live review, acceptance and handoff;
source fixtures do not establish schedule activation or live completeness.

Authority coverage is assessed identically during sync-only and indexed review.
`coverage.unavailablePartitions` counts genuine or uncertain current-generation
access losses. `coverage.deletedPartitions` separately counts lost partitions
whose canonical channel or scope has an explicit tombstone, including channel
partitions under an explicitly deleted scope. Silence or a missing record is
never deletion evidence. Restoration removes the deletion classification, and
regrant removes the loss. This classification does not authorize retained
content: lost partitions remain excluded from summaries. Sync-only still does
not start or complete a review, even when all losses are known deletions.

## Advertised family changes

A completed snapshot proves coverage only for its `partitions_complete` families.
A later bounded delta may add advertised families: the cache retains their rows,
access changes and exact acknowledgement intents using the existing client and
generation. It does not infer historical bootstrap coverage from an advertisement
or a handover certificate. Added families remain in `coverage.unfinishedFamilies`,
and terminal catch-up reports a coverage error with `syncComplete=false` until
that bootstrap is proven. Review-only reports the same gap. A delta's
`partitions_complete` cannot replace the saved snapshot coverage.

Family removals, additions during incomplete snapshots, and additions without
the bounded extension fail before committing or acknowledging the page. A
changed snapshot keyset could otherwise skip newly introduced earlier families.
Family and partition coverage also fence indexed review continuations.

The current Tower contract supplies family bootstrap proof at snapshot completion
only. Use the explicit supplementary recovery path for an existing cache:

```sh
bun clis/heartbeat-wake.ts --recover-families --hours 12 --max-wakes 100 --output tmp/docs/handoffs/heartbeat-family-recovery.json
```

Supply the same workspace/Tower/app/cache targeting flags as the ordinary wake.
Recovery creates one durable supplementary v2 client/cache under
`<primary-cache-path>.family-bootstrap/<primary-generation>/<family-set-hash>/`. It downloads a
full bounded snapshot and handover with normal per-page acknowledgements, holding
the primary writer lease during each supplementary wake. The hash pins sorted
advertised and missing families so future additions get their own bootstrap. Budget limits and failed
acknowledgements preserve this cache for the next explicit invocation; rerunning
resumes the same supplementary client, rather than creating clients repeatedly.

After supplementary certification, recovery advances the primary journal past
that boundary. It requires identical authority epoch/access revision, no pending
acks or unavailable partitions, and matching family advertisements. A mismatch
fails clearly; no speculative merge or reset follows. The atomic merge imports
only missing-family rows by decimal version, preserving newer rows and tombstones,
retains primary authority exclusions, and records supplementary checkpoint proof
in `family_bootstraps`. Primary client, generation, cursor and checkpoint revision
are preserved. Coverage changes invalidate indexed review continuations.

Recovery does not assemble or drain review summaries. Its final result certifies
the merged source checkpoint only; Rick must begin a fresh indexed review.
Do not reset caches or manually mark a family complete.
