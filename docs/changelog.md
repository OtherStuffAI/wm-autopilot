# Changelog

## 2026-10-22

- Add **Export nsec** under each bot’s **Identity & advanced** section for authenticated human administrators. A warning identifies the selected bot and its public key; explicit confirmation is required before requesting its current stored private key.
- Reject anonymous users, non-admins, bot identities, NIP-98/capability-broker callers, and delegated sessions. Export uses existing administrator authorization and stored vault custody only; it never rotates, regenerates, or provisions a key. Missing, external, or inconsistent key custody fails explicitly.
- Export responses disable caching. The browser keeps the result transient, clears it on dismissal or page hiding, and ignores responses after cancellation or a change of selection. Keys are excluded from ordinary bot metadata and are never persisted to browser application storage.
- Validation uses disposable fixture identities, including identity matching, access denial, explicit confirmation, cancel, selection, cleanup, and JavaScript MIME handling. Source changes require an operator-controlled Autopilot restart before live activation; implementation does not restart the service.
