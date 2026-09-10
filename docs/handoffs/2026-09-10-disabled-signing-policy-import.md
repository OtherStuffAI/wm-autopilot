# Import reviewed signing policy drafts

Autopilot Settings → Signing Policies now includes **Import reviewed policy** after the administrator inventory loads. The import component uses the existing signing-policy POST service. Existing revision editing, enablement and capability reissue controls retain their behavior.

## Operator steps

1. Hard-refresh the Autopilot browser tab, then open Settings → Signing Policies. Static modules have a 30-second cache lifetime; no server restart is needed.
2. Open the first downloaded policy draft in a text editor, copy the complete JSON object, and paste it into **Reviewed policy draft JSON**.
3. Select **Review disabled policy**. Inspect the displayed JSON, including the ID, full ordered `exactTags`, NIP-98 targets and profile/workspace assignments. The displayed and submitted draft always has `enabled: false`, including when the input says `true`.
4. Select **Create disabled policy**. This creates a new disabled policy only. Confirm the success message and disabled inventory entry.
5. Repeat with the second downloaded draft. Successful creation clears the import input; errors retain it. Correct an error and review again before retrying.

IDs already present in inventory cannot be imported. The existing registry also rejects racing duplicate creation. Invalid JSON and top-level draft shape errors are shown before review; detailed semantic constraints remain validated by the existing server on create. Input edits invalidate the preview and create action. Unknown top-level fields and unsupported assignment fields are rejected rather than silently omitted. Exact tag arrays and profile/workspace arrays are submitted unchanged.

Creation does not enable policies or revoke/reissue any capability. Authenticated repository testing still requires separately approved administrator enablement and deliberate issuance for the intended sessions. Follow the authority and snapshot lifecycle guidance in [exact tag constraints](2026-09-10-exact-nostr-tags.md). No live grant was created, enabled or reissued during implementation.

## Validation and review

- 35 tests passed across signing-policy registry/routes, static asset routes, signing-settings service, existing settings tests and new import DOM flow regressions.
- `bun run typecheck` passed.
- Static asset regression includes the new import module with `application/javascript`.
- Both live `/views/settings/signing-policies-section.js` and `/views/settings/signing-policy-import.js` returned HTTP 200, `application/javascript; charset=utf-8`, and byte-for-byte current source. Cache header: `max-age=30`. No process restart occurred.
- Independent read-only review approved with no blocking findings. Its suggestion to wrap long preview lines was applied.
- Public-source check retains the existing 96 findings with no new findings.
- Published architecture versions v1–v5 were enumerated and v5 scene text/bindings inspected. This change adds no shared-state synchronizer or signing authority.
- The referenced accessibility guide was unavailable at its configured location. New import controls have labels/test IDs, a named section, and a live status region. Validation used the repository's fake-DOM pattern; an authenticated visual browser smoke test remains for the operator. No screenshot or live admin mutation is claimed.

## Context inheritance

The initial context helper call, before any routing overrides, resolved a task binding and task record rather than the retained origin thread. Workspace and bot were inherited and available; no pipeline run context was present. A no-argument task-comments helper read the assigned execution contract successfully. The separate CLI task read was denied by the broker with `NIP-98 origin is not allowed`; no signing workaround was attempted. Exact dispatch metadata belongs in the manager/task report, not this portable handoff.
