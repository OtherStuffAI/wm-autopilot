# Imported credentials

Autopilot's Secrets page at `/secrets` manages imported owner credentials for
pipelines and agent sessions. The avatar menu links to it; the live sessions view
remains at `/live`. This is separate from personal provider settings, stable bot
identity custody, application signer grants, instance identity and Tier 2 keys.
Tower retains shared coordination state; imported values never move to Tower.

Management is restricted to the authenticated owner. A delegated/broker session
cannot manage credentials on behalf of that owner. List, detail and audit return
metadata only. The page reads that metadata through Dexie and Alpine. Value
inputs are masked, transient, cleared on submission and never stored in IndexedDB.
Create and update accept a value; no browser API retrieves a stored value.

Each credential has an owner and workspace (`local` for ordinary Autopilot runs,
or an active owner-managed Flight Deck workspace). Every use requires both an
allowed identity and an enabled context. Pipeline selection uses the existing
stable definition IDs exposed by the pipeline inventory; agent selection uses
validated npubs. “All” means all contexts already authorized under the same
owner/workspace, not cross-owner authority. Owner management does not itself
confer consumer access. New credentials have no use permissions by default.

## Custody and signing

`data/imported-secrets.sqlite` holds public metadata, metadata-only audit and
AES-256-GCM ciphertext. The dedicated random wrapping key lives at
`data/imported-secrets/master.key`. Both are host-owned private files; keys are
never copied to agent environments or stable-bot vault records. Ciphertext is
bound to credential ID, owner, workspace, type and public identity. Decrypted
byte buffers are cleared after the operation. This prevents routine accidental
disclosure; it does not isolate hostile code running as the same OS user.

Nostr imports accept nsec or 32-byte hex keys and show the derived public npub.
They default to sign-only and selected-kind mode. Existing policies without
`kindMode` remain selected; their per-kind content, tag and required/exact-tag
constraints are preserved. The editor offers common kinds plus custom numeric
kinds from 0 through 65535 with the same per-kind constraints.

The owner can explicitly choose **All Nostr kinds** (`policy.kindMode: "all"`).
This includes HTTP authentication (27235), instruction events and custom tags.
All mode has fixed limits: 8192 UTF-8 content bytes, 64 tags, 64 strings per tag,
16384 aggregate UTF-8 tag bytes, and a timestamp within five minutes of signing.
Kinds must be integers from 0 through 65535. Selected rules are retained but do
not restrict all mode; switching back reactivates them. Empty selected rules
permit no signing. Unknown modes and invalid kinds are rejected.

Allowed consumers can authenticate to external services as the imported identity,
including services that grant it powerful permissions. Choose all mode only for
consumers trusted with that authority. It does not change the session identity,
mint internal broker grants or widen stable-bot signing capabilities. Identity,
owner/workspace, pipeline/session, export and revocation checks still apply.
The signer returns a verified signed event, not its key. It never publishes.

Changing a public identity or credential type resets consumer grants, export
permission and signing rules, even if the replacement request contains the old
policy. Save the replacement, verify the new public npub, then authorize it in a
separate edit. Revocation immediately rejects subsequent requests and removes
stored ciphertext. Previously returned material or signatures cannot be recalled.

Return/export is a separate explicit permission, checked under the same
identity/context policy. This applies to ordinary values and Nostr keys.
Signing-only keys cannot be exported through the browser, pipeline adapter or
session tool. An explicitly returned value can enter the recipient's session,
transcript and downstream systems; it cannot be recalled and its signing-kind
limits no longer constrain the recipient's independent use of the exported key.

## Deterministic pipeline use

Use opaque credential references from the metadata page, never raw values in a
pipeline definition, inputs, prompts or outputs. Built-in code functions are
reserved for the trusted runner and cannot be used through an unbound function
call. The runner pins the principal/workspace independently of input JSON and
uses its actual persisted definition ID. Child runs inherit the root authority
but must also satisfy their own definition selection and live ancestry.

An owner-configured unattended schedule uses its owner's identity in the `local`
workspace. An authenticated API call uses its real actor identity. Agent Direct
and bot-started runs use the selected bot principal in the server-bound workspace.
There is no caller-selected pipeline ID, agent npub or owner impersonation. Runs
without pinned secret authority, including old historical runs and the legacy
shared-token/unauthenticated HTTP trigger path, cannot consume credentials.
Start a new authenticated run after activation. Resuming a new run retains its
original authority; caller inputs cannot widen it.

A signing step (replace the reference with your opaque credential ID):

```json
{
  "name": "sign-approved-note",
  "type": "code",
  "function": "secrets.signNostr",
  "input": { "value": {
    "credentialRef": "<credential UUID>",
    "event": { "kind": 1, "content": "Approved post", "tags": [] }
  } },
  "assign": "$.signed",
  "display": {
    "in": [{ "label": "Credential", "path": "$.credentialRef", "format": "text" }],
    "out": [{ "label": "Signed Event", "path": "$.event", "format": "json" }]
  }
}
```

`secrets.http` consumes an explicitly export-enabled credential transiently as a
Bearer header for an HTTPS request. Arguments are `credentialRef`, `url`, optional
`method` (default POST) and `body`. Redirects are refused, requests time out after
15 seconds, and response bodies/headers are discarded so an upstream echo cannot
enter pipeline evidence. Only `{delivered, status, credentialRef}` is returned.
The credential is registered with evidence redaction before network use. This
adapter is the supported deterministic ordinary-secret consumer; raw return to
pipeline state is deliberately unavailable. Arbitrary CLI/environment injection
is not provided by this release.

## Session use

MCP `use_secret` accepts `{credentialRef, operation:"sign"|"return", event?}`.
It calls `/api/mcp/capabilities/secrets` through the existing capability client.
The server verifies token expiry/revocation, nonce, rate, live session owner,
bound stable bot/profile and workspace on each call. Agent/owner/workspace claims
in the request are rejected. The imported identity never replaces session auth.
A stopped session, rotated bot identity, changed workspace or revoked credential
denies subsequent use. `return` requires the explicit export permission.

## Activation and recovery

Source tests do not activate a running host. An operator must restart Autopilot
externally after review; managed sessions must not restart their host. Then check
the avatar link, create a synthetic sign-only credential, select allowed npubs and
contexts, run a deterministic signing step, exercise the session tool and revoke.
Check that metadata/audit contain no values and denied use remains denied.
No production key, relay posting, external publishing or grant creation is needed.

Runtime backups discover and capture the encrypted SQLite database. The imported
wrapping key must be custodied and restored independently, like the bot-vault
wrapping key; database ciphertext alone is insufficient. Preserve the pair across
container/native restarts, and never replace a missing wrapping key for an
existing credential database. Do not commit runtime state or keys.

## Navigation regression checks

The avatar uses SPA click dispatch to `/secrets`. Authentication restoration keeps
that requested route; anonymous viewers still return to Home after auth resolves.

Run `bun test ./src/ui/secrets/navigation.test.js` for click dispatch and guest
checks. Run the full browser regression with:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs bun test scripts/secrets-navigation.browser.test.ts
```

This covers the full HTML/app entrypoint,
avatar selection, history back/forward, reload with delayed authentication and
anonymous denial. Set `BROWSER_EXECUTABLE` if a system Chrome is required.
The browser test uses synthetic services and an async auth adapter through the
normal identity UI API; it does not validate production login or owner CRUD.
