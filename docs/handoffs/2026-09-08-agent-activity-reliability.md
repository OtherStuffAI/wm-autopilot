# Agent working update publication reliability

Tracking task: `74005209-69cb-4074-b548-e9eeffd3f435`.

Autopilot now publishes every unseen explicit Codex commentary entry in transcript order. It deduplicates event/response mirrors, keeps equal timestamps and repeated explicit messages distinct, and selects the accepted turn independently of newer turns. Internal reasoning, tool arguments, tool results, and final answers never enter the activity extractor. The existing latest-activity reader remains available to other callers.

Publication claims and public request payloads are saved atomically in SQLite. Failed and crash-interrupted claims reuse their original sequence; accepted claims advance the publisher checkpoint. Existing latest-only claims migrate to the new transcript entry identities without republishing accepted history. Signing credentials are never written into publication payloads or transcript recovery records.

An independent recovery service starts after subscriptions reload and checks up to 100 pending sources and 100 pending deliveries each pass. It retries every 10 seconds, limits each delivery to two seconds, prevents overlapping recovery passes, and keeps pending work after terminal states. It resolves the current active subscription identity or uses the existing profile vault runner for the saved Agent Direct turn after validating its workspace, thread, agent, and transport binding. Source scan generations prevent an older successful read from clearing a newer pending failure.

Both normal lifecycle paths drain commentary before recording final reply completion. The durable delivery reconciler also drains commentary when recovering a frozen reply, using saved native transcript routing when the session is archived. A failed transcript read is itself durable, so unclaimed final commentary can be recovered after terminal publication and restart. Tower must accept a late commentary entry independently of the terminal snapshot, including when the late entry has a higher sequence.

## Compatibility limit

For a pre-upgrade turn where the latest-only publisher already accepted a late commentary entry, newly discovered earlier native commentary receives later publication sequences during backfill. History remains consistently publication-ordered across live events and reload; this historical migration does not retroactively reorder the already accepted entry. New-code batches preserve native transcript order, and replay reuses the original sequence.

## Contract and activation

The Tower PUT request contract is unchanged. Deploy the accompanying Tower changes first: retained activity/history, idempotent same-sequence retries, and late commentary append without terminal snapshot regression. Then restart Autopilot externally after review; the runtime performs the additive SQLite schema migration and starts recovery. No runtime was restarted and no deployment branch was pushed during implementation. Browser behavior and end-to-end activation still require the manager's integrated validation after the three services are activated.

## Validation

- Focused publication, extraction, lifecycle, and delivery recovery suites: 61 passed, 0 failed, using an isolated source copy with a fresh `data/` directory.
- `bun run typecheck`: passed.
- Full native suite with `bun test --timeout 20000`: 2410 passed, 23 skipped, 0 failed. The final rerun after additional regression coverage produced 2412 passed, 23 skipped, and one existing hardcoded 10-second timeout: `Agent Direct Chat runtime > enforces the default inclusive window at the normal publication boundary`. That exact timeout also reproduced on clean HEAD. The final isolated targeted recheck passed in 5.9 seconds (1 passed, 0 failed).
- The default five-second test timeout produced native session discovery timeouts also reproduced against clean HEAD. The 20-second timeout supplies headroom for those existing tests; it does not change runtime behavior.
- `bun run quality:public-source`: fails on existing tracked docs/tests; its output matches clean HEAD byte for byte. None of the reported violations originates in this change.
- `git diff --check`: passed.

Initial focused testing exposed the repository's hardcoded singleton database path during module import (`SQLITE_BUSY`), despite individual tests using temporary databases. Subsequent focused and complete suites ran from temporary source copies with isolated databases. No destructive live-data tests ran.
