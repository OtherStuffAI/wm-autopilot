# Proposal-only bug consolidation

`clis/consolidate-bugs.ts` reads all approved channel task pages through the
broker-aware `FlightDeckPgClient`. Scope task rollups cannot prove completeness.
The helper does not dispatch implementation or intervene in user sessions.

Keep operational configuration, inputs and evidence in an existing Git-ignored,
untracked state directory. The helper rejects symlinks, verifies the destination,
and shares the existing atomic `lock/owner.json` lock. It never expires a lock.
Mutable commands acquire and release their own lock; do not wrap them in a
second externally acquired lock. Read-only scans do not modify shared state.

`config.json` contains the approved workspace, scope and complete channel map:

```json
{
  "workspace_id": "approved-workspace",
  "scope_id": "approved-suite-scope",
  "channels": [{"id": "approved-channel", "name": "Bugs", "scope_id": "approved-suite-scope"}],
  "delivery": {"channel_id": "authorised-dm-channel", "thread_id": "authorised-dm-thread"}
}
```

Verify this map from authoritative scope/channel references. Enumeration must
match it exactly and each channel must pass a fresh scoped read. Hidden,
revoked, moved, renamed or newly added channels produce explicit partial
coverage. The current enumeration route truncates at 200; a full-size response
with a null cursor is partial, not proof of completeness. No workspace sweep or
access-policy fallback is attempted.

Run a read-only scan using the current checkout:

```sh
bun clis/consolidate-bugs.ts scan --root "$STATE_DIR" --out "$EVIDENCE_DIR/scan.json"
```

Defaults are 100 tasks per page, 50 pages and 80 sequential requests; budgets
include failed requests. Stdout reports only completeness, channel/page/task
counts and gap reason codes. Private tasks and cursor values stay in the ignored
output. Opaque cursors preserve timestamp precision and tied-sort ordering.
Invalid, repeated and inconsistent cursors terminate as partial. A rate limit
stops the run; two denied channel paths stop further requests.

For a scheduled scan, add `--persist`. Each complete page is atomically saved in
`task-scan.json`, with the cursor for the next page. `--resume` continues an
incomplete scan after revalidating the approved map and channel ACLs. Do not
resume an old completed scan: start fresh each scheduled pass. A resume is a
continuation of the original scan start time, not a new snapshot. Tasks can
change during pagination; reconcile every matching task and its latest comments
against authoritative records before writes. The next fresh scan plus the
incident overlap catches later changes; this API does not offer snapshot
isolation.

Read full incident threads, attachments and matching tasks after the scan.
Keep facts, hypotheses and causes separate. Compare existing task links, states,
owners, completed fixes and in-flight work before creating a proposal. New
proposals are not execution authority. A complete task scan alone never advances
the incident checkpoint.

For an existing task, `link --input link.json` accepts `channel_id`, `task_id` and
an exact comment `body`. It reads the current task and comments, checks the task
again for concurrent changes, and adds the comment once. It preserves the task
body, state and owner. An ambiguous response is reconciled by comment readback;
it is not blindly retried. A truncated comment read is a blocker.

Only after semantic reconciliation rules out an existing task, `proposal
--input proposal.json` accepts `channel_id`, a stable incident/fix-boundary
`key`, `title` and `body`. The body must contain `Proposed remediation, awaiting
Pete's decision; implementation not authorised.` A stable hashed description
marker survives subsequent evidence edits. A complete approved scan precedes
creation and readback. The durable intent prevents duplicate creation after an
uncertain response; unresolved uncertainty requires review. Creates use backlog
and do not assign an implementation agent. Verify supported human assignment
separately. A description marker is consumer reconciliation, not server-enforced
idempotency. Do not change a boundary key to bypass an unresolved intent.

`finalize --input review.json` requires the current `state_signature` and
`scan_signature` (SHA-256 of `JSON.stringify` of the parsed state/scan), boolean
`incidents_complete` and `reconciliation_complete`, full reviewed `groups`,
`incident_evidence`, `unresolved_questions`, material `recommendation`, and
optional `blocker`. Preserve all existing unrelated fields and groups. The helper
checks state freshness under the lock, saves incident groups and task links
first, then advances `last_successful_scan` to the original scan start only when
all three coverage/reconciliation conditions are complete. Partial scans preserve
collected data and the old checkpoint. Failed persistence prevents advancement.
The incident reader must continue using its existing overlap from that checkpoint.

`deliver --input digest.json` uses the configured authorised thread. Inputs are
`kind` (`recommendation` or `blocker`), a stable business-level `material` object
and readable `body`. Exclude run time, scan counters and unchanged evidence from
that material fingerprint. Delivery has a separate durable `delivery.json`
outbox and is not a scan checkpoint condition. An attempted but unverified send
is reconciled by same-bot exact-body thread readback before any further send.
Changed digest bodies cannot replace pending uncertainty. Verified unchanged
recommendations are suppressed even after an intervening blocker; repeated
unchanged blockers are suppressed/rate-limited for 24 hours. Coverage gaps remain
in scan/state evidence even when no DM is sent. Keep the legacy delivered-digest
record and compare it during the initial migration; do not manufacture a digest
to seed the new outbox.

Validation uses controlled fixtures for >200 tasks, ties, interrupted resume,
cursor errors, access changes, uncertain writes, disk failures and DM failures.
Live dry scans prove accessible task coverage only. They do not validate incident
processing, checkpoint writes, DM sends or the original application bugs. CLI
source executes directly without a host restart; a running Autopilot process
retains its loaded modules until an operator-approved restart. Record that limit
when handing off runtime or scheduler validation.
