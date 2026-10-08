# Read-only heartbeat snapshot

Run in an Autopilot agent session with `WINGMAN_BROKER_URL` (or `WINGMAN_URL`),
`SESSION_ID` and `WINGMAN_CAPABILITY`. Signing uses the broker's agent identity;
no private key, DM delivery, trigger edits or process lifecycle operation is used.
Tower URL and app namespace must come from the live broker Flight Deck context.
Inherited Tower environment defaults are not used. Optional `--tower-url` and
`--app-npub` assertions must match that context.

```sh
bun clis/heartbeat-wake.ts --workspace 2e5caefd-dd65-45d2-b747-ee874e8e5fc9 --hours 12 --max-pages 100 --max-time-ms 120000 --request-timeout-ms 15000 --json --output tmp/docs/handoffs/heartbeat-snapshot.json
bun clis/heartbeat-wake.ts --smoke
bun test ./src/heartbeat/heartbeat-wake.test.ts
```

Ensure the operational output directory exists and is Git-ignored/untracked.
Omitting `--workspace` selects only the active broker Flight Deck workspace;
missing active workspace fails clearly. No workspace enumeration occurs. An
explicit workspace uses the context's authoritative Tower/app namespace and must
be authorized there.

`--hours` is recent-triage metadata (`since` and `recentTriageHours`), never a sync
filter. The first sync request has no cursor or since. Subsequent requests use
Tower's returned snapshot cursor, stopping only when `has_more=false` and
`snapshot_complete=true`, even though the terminal event cursor is non-null.
Channel bundles and collections are merged by record id; repeated messages are
deduplicated and old open tasks remain included.

Output retains `generatedAt`, `since`, `botNpub`, `brokerRequests` and `workspaces`
with merged `sync`, and adds `complete`, `errors`, `coverage` and `rawPages`.
`--json` is accepted; without `--output`, stdout remains the full JSON snapshot.
With `--output`, the file contains full evidence and stdout contains a small JSON
coverage summary. Treat raw evidence as private workspace material.

Exit 0 means the visible channel snapshot completed; exit 2 means partial or
invalid snapshot coverage, with successful pages and received error/mismatched
bodies preserved. Exit 1 means setup/auth/context/identity or file output failed.
Coverage reports visible, visited, completed and missing channel counts, missing
channel IDs, pages and merged collection counts. A channel with unfinished message
pagination is missing from completed coverage even if visited. If no valid page
arrived, `channelDirectoryKnown=false`; zero known missing channels is not proof
of completeness. Page cap, repeated cursor, malformed metadata, identity mismatch,
HTTP/network failure and timeout all prevent success. Bounds cover broker requests,
Tower requests and body reads. No retries or automatic resume are performed.

Limitations: this reflects authorized visible channels, not inaccessible channels.
Tower currently caps several non-message collections and channel/scope discovery
at 10,000 records without pagination flags; client completion cannot certify data
beyond those server limits. Snapshot pages can observe concurrent mutations; this
helper does not promise a transactionally frozen database view. The manager owns
local wrappers and live broker verification; CLI execution needs no server restart.
