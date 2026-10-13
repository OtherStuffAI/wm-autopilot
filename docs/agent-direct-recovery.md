# Agent Direct interruption and recovery

An observed prompt receipt owns execution. A capacity error or final-observation
timeout must not retire the manager and submit the accepted request again. The
manager may still own workers or have performed side effects. Release observation
to durable reconciliation and retain the original turn and prompt boundary.

Interruption and recovery notices use separate durable delivery rows with
`promptType=direct_chat_status`. Each notice has a deterministic turn/request ID,
immutable originating workspace/channel/thread/agent binding, and the same leased
publication and Tower idempotency protocol as final responses. A status row does
not consume pending human input, mark the original turn completed, advance its
history checkpoint, or emit a successful completion activity. A later verified
final uses the original turn's request ID. Transport retries retain identical
frozen payloads.

Actual native-session replacement transfers prompt queues and supervised dispatch
records. Callback wake state resets for the replacement; worker execution and
terminal fingerprints are retained. Transfer requires the same owner and native
session identity and never steals ownership from an active original runtime.
Archived turns failed for missing/stopped session evidence can regain observation
ownership on a verified same-native resume. Frozen finals cannot be rebound.

A fresh continuity manager receives a recovery instruction to inspect existing
workers, task/thread records, transcripts and software evidence. The accepted
request is historical context, not an instruction to execute its effects again.
Use durable Autopilot dispatch for delegated work. Native collaboration children
cannot be recovered from the supervisor's transcript or an archived screenshot.

Archive timestamps and earlier completed-turn messages do not establish current
completion. SDK streaming snapshots are not archived finals. Codex archive
reconciliation requires native `final_answer` evidence after the accepted boundary;
a later error supersedes earlier assistant text. Continue/steering remains inside
the accepted request's observation boundary.

The archive viewer materializes history into Dexie before reading it and binds
loads to the selected session and request. Navigation discards obsolete responses;
the archive badge identifies an interrupted request separately from archive state.

Source checks do not activate runtime changes. After an operator-authorized
restart, smoke-test capacity failure, Continue, a surviving dispatched worker,
archive/native resume, an interrupted notice, a verified final, publication retry,
and rapid switching between live and archived sessions. Verify originating-thread
records and dispatch ownership; screenshots alone are insufficient evidence.
