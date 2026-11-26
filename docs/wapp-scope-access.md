# WApp scope access

Autopilot registration, binding changes and allowlist refreshes resolve scope readers through typed Flight Deck PG APIs. They do not require project-local `board.json`, a Yoke CLI, encrypted board caches or an exported owner key. This shared path supports independently registered applications.

The resolver retains the requesting stable agent identity. Its enabled profile must belong to the effective Autopilot owner; existing broker vault custody supplies signing only for that profile. The registration authority remains separate from the scope inspection signer. A missing profile or vault key is an error, never a reason to substitute the owner, instance identity or another agent.

The effective owner must have exactly one available backend connection matching the selected Tower binding's URL and workspace owner. An explicit workspace UUID selects its descriptor directly. Older bindings without a workspace UUID require unambiguous workspace discovery. Requests carry the durable backend connection context, source app identity and exact-route NIP-98 signatures through the existing transport abstraction.

Every response must match the selected workspace UUID, workspace owner, source app and service identities. Scope inspection requires `scope.manage`; group inspection requires the server's existing workspace management permission. A scope being visible is insufficient evidence of its readers. The resolver uses only exact-scope `scope.read` grants, canonical workspace actors and server-expanded effective group members, checking actor IDs and npubs against the workspace principal directory. Unavailable, inconsistent or incomplete permission/group responses fail closed. Scope lineage and allowed npubs supplied by clients are not authoritative.

Typed PG scopes are currently flat, so their lineage levels are null. If authoritative scope responses carry explicit lineage fields, those are preserved; no hierarchy is inferred from labels, local paths or parent access. Nested group membership is expanded by NStack, not reconstructed from local caches. Scope inspection is a sequence of reads, not an atomic ACL snapshot; subsequent refreshes re-read current grants and membership.

Human-owner requests retain their identity but currently return a precise missing downstream PG signing capability error. A signature for an Autopilot registration POST cannot be replayed against different PG GET routes. Supporting owner-driven browser registration requires an explicit downstream signing/delegation contract; this resolver does not impersonate the owner.

A scope reader allowlist does not replace an application's own data authorization. An app requiring private per-user records must enforce that policy independently.

## Validation and activation

Run the focused WApp, PG-client and owner-space route tests, plus the repository validation checks. Use an isolated source tree for tests that initialize singleton stores, so the running Autopilot database is untouched.

After source review and explicit operator restart approval, restart Autopilot from outside managed agent sessions. Then retry the original owner-space registration with the same managed app, exact Tower binding and delegated stable agent. Verify the resulting owner, creator, workspace, scope, lineage and scope-derived reader list, encrypted signing custody, and registration response. Check a wrong-workspace scope and unresolved permissions are rejected before persistence or Tower registration. Keep app activation and publication separate from registration smoke testing.
