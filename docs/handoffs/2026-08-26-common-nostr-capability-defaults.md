# Expand safe default Nostr capabilities

## Goal

Fix Autopilot's default session capability policy so Rick and other stable bot identities can perform ordinary Nostr work through the local capability broker, including Zapstore publication, Blossom authorization, and NIP-44 encrypt/decrypt, without exporting private keys or granting unrestricted signing.

Origin: Flight Deck features thread `8633e75e-3a33-47d4-9e40-b19bb1aeac43`, following the blocked WMAPP Zapstore release task and the diagnostic document “Why Rick's Nostr signer rejected the WMAPP Zapstore release”.

## Confirmed failure

The same manager session, using Rick's stable broker identity, successfully signed kind `1` but rejected kind `32267` with `Nostr event kind is not allowed`. The publishing worker was also denied the Zapstore/Blossom-related kinds `24242`, `3063`, `30063`, and `32267`. This proves the failure is the default capability kind allowlist, not worker delegation and not a missing Rick private key.

Current code evidence:

- `buildDefaultAgentCapabilityPolicy()` in `src/signing/capability-broker.ts` grants `nostr.sign`, `nip44.encrypt`, `nip44.decrypt`, and `blossom.authorize` operations.
- Its Nostr kind list is currently only `0, 1, 3, 4, 7, 10002, 30078, 33358`.
- NIP-44 encrypt/decrypt are separate broker operations with peer constraints; they are not event kinds.
- Blossom has a dedicated broker operation that produces kind `24242`; generic event signing may still need kind `24242` for compatible publishing clients.

The current architecture reference is Wingman Suite Architecture v4. It keeps agent key access and delegation inside Autopilot's mediated boundary; this change must preserve that boundary.

## Required work

1. Audit the current default-policy issuance path for manager sessions and dispatched sessions. Ensure both receive the same corrected default policy.
2. Define and document a conservative named set of common safe Nostr event kinds. It must include the minimum release path:
   - `24242` — Blossom authorization
   - `3063` — software asset
   - `30063` — software release
   - `32267` — app metadata
3. Include other genuinely common kinds already supported by Autopilot's normal agent workflows where the risk is comparable, with an inline rationale or a clearly named constant. Do not use `kind=*`, an arbitrary numeric range, or permit all replaceable/ephemeral kinds wholesale.
4. Keep NIP-44 encrypt/decrypt represented and tested as separate broker operations. Verify the MCP tools receive those capabilities in both manager and dispatched sessions and preserve peer/size/error constraints.
5. Keep Blossom authorization's server, method, and object-size constraints intact. Do not weaken server scoping merely to support Zapstore.
6. Add focused regression tests proving:
   - the minimum Zapstore kinds are allowed by the default policy;
   - existing kinds including Flight Deck instruction kind `33358` remain allowed;
   - an unknown/unapproved kind remains denied;
   - NIP-44 encrypt/decrypt remain available and policy constrained;
   - default issuance/inheritance covers ordinary manager and dispatched-session creation paths, if separate paths exist.
7. Update relevant capability documentation so future workers understand the difference between event kinds, Blossom authorization, and encryption/decryption operations.

## Constraints

- Work in `/Users/mini/code/wm/autopilot` on `main`.
- Preserve concurrent work. Before committing, inspect the full worktree and commit all nonignored tested state unless there is a clear safety reason to pause.
- Never read, export, search for, or fall back to a raw Nostr private key, bunker URI, or human Tier-2 signer.
- Do not restart the running Autopilot service. Report whether a restart/new session is required for the corrected policy to take effect.
- Do not publish the WMAPP release as part of this task. The blocked release task will resume after the platform fix is active.

## Validation and handoff

Run the narrow capability-broker and session-capability tests first, then the repo's appropriate broader test/typecheck/lint checks. Commit and push `main`. Report the exact files changed, policy rationale, test commands/results, commit hash, and any activation requirement on the Flight Deck task.
