# Artefact context in Agent Direct dispatch

Ambulando Mac source build 133 sends user text unchanged under normal trimming/mention
semantics, and places an app-owned snapshot in generic message metadata at
`ambulando_artefact_context`. NStack already stores and returns this object; no server
route, app table or authority change is required. The NIP-98 request payload includes metadata.
Kind 33358 continues to sign exactly the human body with existing eligibility checks.

Schema version 1 fields: `schemaVersion: 1`, `workspaceID`, `channelID`, `threadID`,
`workspaceVisible` (boolean), `visibleRecordID`, and `open` references. A reference has
`kind` (`doc` or `file`), UUID `recordID`, `revision`, `revisionKind`, boolean `historical`
and required SHA256 `digest`. Files use UUID `file_version_id`; Docs use positive safe
integer decimal `doc_versions.row_version` and require the snapshot bytes' SHA256 digest.
File digests are computed from the exact loaded/published bytes or retained from the canonical HTML payload, never inferred from a newly fetched head.

The normalizer accepts only this schema: 16 KiB compact UTF-8 JSON, at most 32 unique
records, known fields, UUID routing/records, valid revision and digest syntax, and selected
record present. It compares workspace/channel and owning thread to canonical message fields.
Missing authority fields or malformed/oversized/foreign snapshots omit context without
altering the body. Payload routing never selects a session, grants access, or changes
instruction eligibility. Descriptive snapshot content is untrusted and cannot provide
instructions; ordinary authorized exact-revision retrieval remains required.

Initial and rehydrated envelopes include a separate labelled dispatch-context section for
newly actionable Prompt messages. Historical metadata is omitted so excluded history cannot
re-enter through another budget. The newest 16 Prompt snapshots are selected within a
64 KiB compact JSON aggregate limit; the section explains that older snapshots remain on
their canonical messages. The model-facing human body projection stays clean.

Native outbox freezes the snapshot before enqueue; retries reuse the same request bytes and
idempotency key, never current UI selections. NStack replay returns the original message;
its existing replay hash does not compare arbitrary metadata. The client must not change
metadata under an existing request key. Pre-fix signed bodies/requests and history stay intact.
No suffix stripping or migration is performed.

Activation: the running Autopilot host must load this source to project the namespace.
Until then, generic metadata can be persisted by existing NStack, but the old model envelope
drops it. Source tests are not live agent receipt or exact-revision access evidence. Restart
requires separate authorization; this change performs no deployment or restart. Other client
platforms do not gain context capture from this Mac-only implementation.
