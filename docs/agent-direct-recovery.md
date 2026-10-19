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

## Callback wake publication boundary

An accepted human Agent Direct turn fences supervised callback wake delivery for
the same session until the human turn reaches a terminal delivery state. Runtime
stability alone is not sufficient: a final may already be visible in the native
session transcript while its Agent Direct delivery is still being frozen,
reported, or published. The callback remains unresolved in its durable inbox and
becomes eligible again after the human delivery is published, suppressed, or
otherwise terminal.

The live runtime freezes the observed human final and its immutable source-message,
thread, session, agent, and `prompt_type=direct_chat` binding before post-turn
reporting or activity publication can yield. A later callback final therefore
cannot replace that payload even if callback publication overlaps a delayed Tower
request. Callback reporting retains its separate `dispatch_inbox_wake` turn and
idempotency key.

The fresh-human cutoff introduced in `08444f3` protects a different boundary: a
new human trigger reactivating an inactive session retires older work. It does not
run when the already accepted human turn becomes stable after producing its final,
which is the point where callback auto-dispatch previously overtook publication.
The session-level publication fence covers that same-turn gap without weakening
fresh-human supersession, callback durability, or same-session reuse.

The archive viewer materializes history into Dexie before reading it and binds
loads to the selected session and request. Navigation discards obsolete responses;
the archive badge identifies an interrupted request separately from archive state.

Source checks do not activate runtime changes. After an operator-authorized
restart, smoke-test capacity failure, Continue, a surviving dispatched worker,
archive/native resume, an interrupted notice, a verified final, publication retry,
and rapid switching between live and archived sessions. Verify originating-thread
records and dispatch ownership; screenshots alone are insufficient evidence.


## New human input supersedes an inactive session's old work

Under Pete's 2026-10-15 policy, a newly verified and authorised human message for an inactive bound session retires prior queued instructions and arrived callback notifications before rehydration. The persisted exact-item cutoff and fresh-message instruction floor protect new/concurrent arrivals. Old accepted publication observers are also retired, so an obsolete callback cannot adopt the new human final. Conversation/thread history remains context; supersession does not prove old worker success or cancel workers. Automatic recovery without a new human trigger retains the existing receipt/reconciliation rules. See [session prompt queue](session-prompt-queue.md) for the consume CLI/API, crash boundaries and activation tests.
