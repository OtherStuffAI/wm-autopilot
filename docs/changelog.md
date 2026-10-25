# Changelog

## 2026-10-25

- Add direct NStack HTTPS address entry to Workspaces alongside saved NBrowser selection. Discover workspaces accessible to enabled local agents using existing signed Tower discovery; select, review, connect and retry through the same verified, duplicate-safe setup and monitoring. Invalid addresses, access failures and discovery errors remain visible.
- Add a disabled “Browse NStack directory — coming soon” choice explaining future Nostr announcements of FIPS and HTTP endpoints. Existing manual and AgentConnect setup remain available.

## 2026-10-22

- Add **Connect to NStack** in Workspaces: use Nostr Browser’s consented saved connections, select multiple workspaces, review setup, and see individual results with retry for failures. Existing AgentConnect and manual paths remain available.
- Verify Tower workspace descriptors with local agent identities before using existing PG onboarding, event monitoring, dispatch authorization and recovery. Repeated setup reuses matching connections and subscriptions; paused, revoked and locally disconnected subscriptions remain under their existing controls. Ambulando and Flight Deck resolve through the same workspace/app identities.
- Keep discovery, selection and setup results in Dexie with Alpine live queries. Cancellation and identity/discovery changes invalidate pending UI responses; connection health is shown separately from agent activity. Browser discovery supplies public connection details and never grants runtime authority.

- Add **Export nsec** under each bot’s **Identity & advanced** section for authenticated human administrators. A warning identifies the selected bot and its public key; explicit confirmation is required before requesting its current stored private key.
- Reject anonymous users, non-admins, bot identities, NIP-98/capability-broker callers, and delegated sessions. Export uses existing administrator authorization and stored vault custody only; it never rotates, regenerates, or provisions a key. Missing, external, or inconsistent key custody fails explicitly.
- Export responses disable caching. The browser keeps the result transient, clears it on dismissal or page hiding, and ignores responses after cancellation or a change of selection. Keys are excluded from ordinary bot metadata and are never persisted to browser application storage.
- Validation uses disposable fixture identities, including identity matching, access denial, explicit confirmation, cancel, selection, cleanup, and JavaScript MIME handling. Source changes require an operator-controlled Autopilot restart before live activation; implementation does not restart the service.
