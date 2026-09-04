# Admin-managed signing policies

## Objective

Implement an administrator-managed signing-policy system in Autopilot and a narrowly constrained Tower Forgejo OIDC login policy. Pete must be able to review and update policies in Settings after this release without changing source code. A policy edit must never silently widen an already-issued session capability.

Work only in `/Users/mini/code/wm/autopilot` on `main`. Preserve concurrent work and the three commits currently ahead of `origin/main`. Commit all nonignored tested state when complete. Do not push, deploy, restart Autopilot, or change Tower/Flight Deck.

Origin: Flight Deck thread `Fix Git Signing`, message `26ce0153-0ad0-42c6-8528-7b8be7c5ebe2`.

## Architectural boundary

The latest saved Wingman Suite Architecture board is `v4` at:

`/Users/mini/code/wingmanbefree/artifact-wapp/artifacts/Wingman_Suite/wingman-suite-arch/v4/`

It keeps access/approval/delegation above the execution layer, Autopilot responsible for agents/runs/apps/workflows, and Tower responsible for shared authority and Git. Therefore:

- Autopilot owns policy definition, assignment, capability issuance/revocation, and broker enforcement.
- Tower remains the authority that validates the signed OIDC proof and decides whether the actor has Forgejo access.
- Do not add a second identity or grant system and do not export signing keys.

## Current implementation facts

- `src/signing/capability-broker.ts` embeds `buildDefaultAgentCapabilityPolicy()` and snapshots that policy into each issued capability.
- Existing policy constraints cover operations, NIP-98 targets/body hashes, Nostr kinds/tags, NIP-44, Blossom and wallet limits.
- `CapabilityBroker.revokeSession()` already revokes capabilities, but there is no public admin policy inventory, policy revision, assignment, affected-session view, or deliberate reissue flow.
- Session issuance is wired in `src/server.ts` and knows owner npub, profile manager, resolved agent profile, bot npub, session metadata, known Tower subscription origins, and Autopilot public origin.
- The Settings shell already has administrator-only pages, instance-settings routes/services, semantic controls, test IDs and route/navigation tests. Keep new UI code modular; do not grow `src/server.ts` or `src/ui/app.js` with feature logic.
- The broker's `nip98.sign` operation currently constructs only `u`, `method`, optional `payload`, and the private session-binding tag. It cannot accept constrained additional challenge tags.
- The current generic `nostr.sign` path allows tag-name restrictions but does not bind the event to an HTTP target/body policy. Do not solve Forgejo login by broadly allowing arbitrary kind-27235 templates through that route.

## Canonical Tower Forgejo OIDC contract

Read-only reference: `/Users/mini/code/wm/tower/src/routes/git-oidc.ts`. Do not edit Tower.

Tower creates a one-minute authorization challenge. The exact completion URL is `${GIT_OIDC_ISSUER}/authorize/complete`; the concrete public path depends on the configured issuer. The POST body is the exact JSON bytes:

```json
{"request_id":"<opaque request id>"}
```

Tower validates a kind `27235` event with exactly one value for each relevant tag:

- `u`: the exact completion URL
- `method`: `POST`
- `payload`: SHA-256 of the exact request body
- `nonce`: the opaque request ID
- `aud`: the configured OIDC client ID from the challenge
- `expiration`: the challenge's exact expiration Unix timestamp

It also requires a valid event, a fresh `created_at`, an unexpired challenge, and an actor with active Tower-backed Forgejo access. Autopilot's private session-binding tag may make the event unacceptable if Tower insists on only known tags; verify live Tower behavior/tests and choose a dedicated broker output that matches the accepted contract while preserving internal audit/binding by capability record rather than weakening target validation.

## Required product behavior

### Policy registry and validation

Add a dedicated, typed, non-secret signing-policy registry rather than storing an opaque free-form string in generic instance settings.

Each effective policy or policy fragment must expose, as applicable:

- stable ID, name, description, enabled state and revision;
- permitted broker operations;
- allowed Nostr event kinds;
- NIP-98 targets by exact origin, methods, exact paths/path prefixes, and payload-hash requirements;
- allowed/required extra tag names and value rules;
- maximum expiry/freshness constraints for dynamic time tags;
- assignment scope (agent profiles and, where current session metadata makes it safe, workspace IDs);
- created/updated timestamp and actor attribution available from the authenticated admin;
- immutable audit/history entries or revision snapshots sufficient to understand who changed what and when.

Validation must reject wildcard or malformed origins, overbroad Forgejo paths, unsafe methods, invalid kinds, duplicate IDs, unknown operations/tag rules, impossible limits, and policy documents that could bypass the normal default constraints.

Preserve the existing default agent policy as a built-in baseline. Custom policy fragments may add narrowly scoped authority to newly issued or explicitly reissued capabilities. Define and test deterministic merge behavior; fail closed on conflict.

### Tower Forgejo Login policy

Ship a named built-in template/policy that can be enabled and assigned by an administrator. It must:

- produce kind `27235` only through NIP-98 signing;
- bind the exact configured HTTPS Tower OIDC completion origin/path and `POST`;
- require a payload hash of the exact request body;
- accept only `nonce`, `aud`, and `expiration` as caller-supplied challenge tags in addition to canonical NIP-98 tags;
- require exactly one of each challenge tag, non-empty bounded values, and an integer expiration after now but no more than the configured short challenge window (default at most 60 seconds);
- prevent caller replacement/duplication of `u`, `method`, `payload`, `created_at`, pubkey, event kind, or any internal capability identity;
- record an allowed/denied audit outcome without logging the bearer capability or private key.

Prefer extending the broker client with an explicit `tags`/challenge input on `nip98.sign` under policy enforcement. If a dedicated operation/endpoint is safer and smaller, document why and keep it equally constrained. Add a CLI or agent-consumable helper only if needed to make the feature testable end-to-end; it must still use the session broker and never accept a raw private key fallback.

### Active-session semantics

- Every issued capability must record the effective policy IDs/revisions used at issuance.
- Policy edits do not mutate or refresh an existing capability's authority.
- Admin APIs/UI show affected active sessions and whether each capability is current or stale relative to its assigned policy revisions.
- Provide an explicit admin action to revoke and reissue a selected active session's capability, using the existing bound identity/profile and current policy resolution. A failed reissue must leave the old capability revoked and clearly report recovery steps; do not silently fall back to the old authority.
- `capability.refresh` remains same-policy renewal only and must not adopt newer policy revisions.

### Admin API and Settings UI

Add authenticated administrator-only routes for list/read/create/update/enable-disable/history and affected sessions, plus explicit revoke/reissue. Non-admin and unauthenticated access must be denied before sensitive policy/session details are returned.

Add a dedicated **Signing Policies** Settings destination with accessible, semantic controls and `data-testid` coverage. It should clearly show:

- operations and Nostr kinds;
- NIP-98 origin/method/path/payload requirements;
- required/allowed tags and expiry constraints;
- assigned profiles/workspaces;
- revision and audit history;
- active current/stale sessions;
- the deliberate revoke/reissue action and its consequence.

The UI may use structured fields plus an advanced JSON representation, but must validate server-side and must not become a generic unrestricted signer configuration surface. Follow the repo's Peekaboo-friendly accessibility requirements.

### Documentation

Update `docs/capability-broker.md` (and any nearby operator docs) with the policy lifecycle, API shape, Forgejo template, revision semantics, restart/activation requirements and a safe test flow. State explicitly that the feature does not grant Tower/Forgejo membership; Tower still decides actor authorization.

## Acceptance tests

At minimum, add regressions proving:

1. The existing built-in policy is unchanged when no custom assignment exists.
2. Only an administrator can read or mutate signing policies and reissue capabilities.
3. Policy validation rejects malformed or widened origins/methods/paths/tag rules/expiry windows.
4. Policy revisions and audit history persist across service reconstruction.
5. Policy assignment resolves deterministically by agent profile/workspace.
6. Editing/enabling a policy marks matching active capabilities stale but does not alter or refresh their authority.
7. Explicit reissue revokes the old token and issues a token carrying the new policy IDs/revisions.
8. An allowed Tower Forgejo challenge produces an event with the exact canonical and dynamic tags, correct body hash and a short valid expiration.
9. Wrong origin, wrong path, wrong method, missing/duplicate/unapproved tag, wrong/absent body hash, expired/far-future expiration and replay are denied.
10. Other kind-27235 or arbitrary generic-event requests do not gain this authority.
11. Settings navigation, admin gating, load/save/error/status states and revoke/reissue confirmation are covered.

Run focused tests while iterating, then:

```bash
bun run typecheck
bun test
git diff --check
```

If the full suite has an unrelated pre-existing failure, isolate and report it with evidence rather than weakening tests.

## Handoff

Commit with an imperative subject of at most 72 characters. Report changed files, policy/security decisions, tests and counts, commit hash, and precisely what Pete can test after an external Autopilot restart. Do not claim the running instance has the new code and do not restart it.
