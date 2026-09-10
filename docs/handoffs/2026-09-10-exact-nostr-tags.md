# Exact Nostr tag constraints

Custom `nostrKindRules` accept an optional field:

```typescript
exactTags?: Array<[string, ...string[]]>;
```

Every entry is a complete, ordered Nostr tag array, including its name. The event must contain exactly one tag with that name, identical in length and every string. Missing tags, duplicate names in the event (including identical copies), extra values, reordered values and different strings are denied. URL spelling is literal, including trailing slashes. A name-only entry such as `["!"]` requires exactly that name-only tag. An omitted or empty list adds no exact constraints. Other names remain governed by the existing allowlist and byte/count limits.

Example custom kind rule (substitute approved destinations before use):

```json
{
  "kind": 30617,
  "maxContentBytes": 0,
  "maxTags": 16,
  "maxTagBytes": 4096,
  "allowedTagNames": ["d", "clone", "relays", "name"],
  "exactTags": [
    ["d", "synthetic"],
    ["clone", "https://git.example/publisher/synthetic.git"],
    ["relays", "wss://relay.example/"]
  ]
}
```

`requiredTags` retains its existing pair-presence semantics. It may overlap with `exactTags` only when its required value equals the exact array's second element. Exact definitions reject non-arrays, empty arrays as tags, non-string elements, disallowed names, repeated names, conflicting required pairs, and impossible combined tag/byte budgets. Duplicate per-kind definitions remain invalid. These checks run both during draft validation and when the broker handles a custom-kind event.

The registry persists validated rules and revision history, revalidates on load, and clones full rules into issued capabilities. The settings JSON editor and save service preserve complete rules; summaries display the full exact arrays. No new static asset or UI state owner is introduced. Existing defaults and policies without the field remain unchanged.

## Review and activation

Install this implementation before saving or issuing policies that rely on `exactTags`. Older binaries do not enforce the field and their normalizer can drop it. Do not downgrade while relying on these restrictions; disable grants and revoke affected capabilities first.

Review the complete candidate event against the allowlist as well as exact constraints. For repository announcements, bound `d`, `clone`, and `relays`; repository state generally needs exact `d` and an appropriately limited ref-name allowlist. NIP-42 uses singular `relay` with a variable `challenge`. This field constrains signed event tags, not network publication destinations or application membership.

An authorized operator must separately load the new code, save/review the disabled draft, confirm assignment scope, then explicitly enable and revoke/reissue intended capabilities. Profile assignments affect future matching session issuances, not just one worker. Existing issued snapshots do not change when a policy is edited or disabled. Record capability expiry, disable the temporary policies when the approved test ends, and revoke every affected snapshot to end authority immediately. There is no automatic policy expiry field.

## Validation

Run the affected signing, signing-route, and settings tests plus `bun run typecheck`. Regressions cover synthetic announcement/state acceptance, duplicate/extra identifier and destination rejection, NIP-42, full ordered multi-value tags, malformed definitions, legacy behavior, stored revisions, compiled broker enforcement, and JSON editor saves. Compare `bun run quality:public-source` against the pre-change findings; historical violations are not resolved by this change.
