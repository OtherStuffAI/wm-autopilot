# Changelog

## 2026-10-30

- Rework Triggers setup and management. Create and edit share one guided form (When / What / Who runs it / Active window) with plain-language trigger and action choices, per-field help, inline validation (including timezone and pipeline JSON), a live summary sentence, and focus management. The list now shows status, readable schedule with timezone, target, identity, next/last run, an accessible enable switch, search and status/type filters, inline confirmation for Run now and Delete, visible refresh errors with retry, and clearer empty, loading and run-history states.
- Trigger types, payloads, owner identity handling and run behaviour are unchanged, except that file-watcher triggers with an active window now save the chosen timezone instead of the server default. Editing never rewrites a saved schedule: midnight stays 00:00 and custom cron expressions are kept verbatim (shown as "Custom schedule") unless you pick a different repeat. Frontend-only; reload the browser to pick up the change, no Autopilot restart needed.

## 2026-10-28

- Document Full Agent's existing arbitrary dedicated NIP-98 signing and add composition coverage for durable mode selection, running-client replacement adoption, private connection independence, exact request binding and replay rejection. Generic kind 27235 signing remains reserved.
- Allow ordinary Admin sessions to sign exact read-only Tower service/workspace/scope discovery requests through connections currently available to their own identity. Resolve only the selected HTTPS/FIPS endpoint; recheck live roles and connection grants without widening custom policies, workspace mutations or external ACLs.
- Apply the live human/agent Admin role consistently to supported server administration, including owner WApps, sessions, pipelines, schedules, control-plane reads and settings. Keep signer identity and resource ownership separate from creator or custody, and retain scoped delegation for nonadmins.
- Expand ordinary admin session signing across supported Autopilot API families and self-signed event kinds without overriding narrow capabilities, crypto size/peer policies, external ACLs, wallet budgets or identity custody. Keep reserved authentication, Blossom and Flight Deck message protocols validated.
- Remove implicit custodian authorization from verified NIP-98 requests; nonadmin cross-owner work requires active scoped owner delegation.
- Verify NIP-98 once per API dispatch, bind bodies and bodyless methods correctly, reject invalid explicit proofs without cookie fallback, and give independent same-second requests distinct nonces while rejecting exact-token replay.

- Show active stable bot identities and profile names alongside humans in Settings Users, without requiring bot login. Use the existing durable admin role and labelled **Is Admin** controls; configured bootstrap and last-admin protections remain in place.
- Let explicitly appointed human or bot admins manage every instance app through ordinary and owner-prefixed app APIs, independent of app ownership, profile custody or session ownership. Signers and app ownership remain intact; linked humans do not confer admin authority.
- Apply admin promotion, demotion and bot deactivation to live app authorization and bounded broker signing. Preserve deliberately constrained signing policies, narrow delegations, exact-session queue restrictions and separate Tower permissions.

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
