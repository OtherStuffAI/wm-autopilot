# Signing policy acceptance fix: constrained custom Nostr kinds

## Context

The administrator-managed signing-policy implementation is committed on `main` at `93fa04455b240b8250971c61fc009147e0b2561a`. Acceptance review found that `validateSigningPolicyDraft()` rejects every `nostr.sign` kind outside `DEFAULT_AGENT_NOSTR_EVENT_KINDS`.

That means administrators still need a release to permit a new Nostr kind, contrary to the product requirement. Fix this without weakening the dedicated NIP-98/kind-27235 boundary.

## Required result

- Permit an administrator policy to add a valid Nostr kind not compiled into the baseline.
- Require explicit, bounded constraints for every custom kind. The policy contract must express and enforce per-kind limits for content and tags. Include at minimum maximum content bytes, maximum tag count, maximum tag bytes, allowed tag names, and optional required exact tag pairs.
- Continue rejecting kind `27235` through generic `nostr.sign`; it is available only through constrained `nip98.sign` targets.
- Apply custom kinds only to newly issued or explicitly reissued capabilities. Existing capabilities must never widen silently.
- Fail closed on missing, duplicate, mismatched, malformed, or unreasonably broad per-kind rules.
- Keep baseline permissions fixed and compatible.
- Show the custom-kind constraints in the Settings summary and preserve structured JSON editing.
- Document the administrator workflow and security boundary.

## Acceptance tests

1. A valid policy adds a previously unknown kind with tight constraints and a new/reissued capability can sign a conforming event.
2. Wrong tag names, missing required tags, oversized content/tags, and an undeclared kind are denied.
3. A custom kind without a matching per-kind rule is rejected.
4. Generic kind `27235` remains rejected.
5. Enabling/editing a policy does not mutate an already issued capability.
6. Focused signing-policy tests and `bun run typecheck` pass; run the full suite and distinguish any pre-existing failure.

## Work rules

Work directly on `/Users/mini/code/wm/autopilot` `main`, starting from `93fa044`. Preserve concurrent changes. Commit all nonignored tested state. Do not push, deploy, start, stop, or restart any service. Report the final commit and exact validation evidence through the supervised dispatch callback.
