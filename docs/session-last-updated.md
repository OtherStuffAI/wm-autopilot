# Session last-updated timestamp

Autopilot session summary and detail responses expose `lastUpdatedAt` as an ISO 8601 UTC timestamp or `null`.

The value is the creation time of the newest persisted session-generated output. The normalized qualifying roles are `assistant`, `agent`, and `agent-working`; the latter represents thinking/reasoning output for adapters that expose it separately.

User messages do not qualify. Queue changes, metadata edits, status polling, and other administrative mutations do not write this projection. A session with no qualifying output reports `null`. Live and archived session responses use the same field and semantics.
