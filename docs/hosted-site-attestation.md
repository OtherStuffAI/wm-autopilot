# App-bound hosted signup attestation

Autopilot can attest a verified hosted-workspace signup for one registered app.
This is separate from session capabilities and the general ApplicationSigner,
which still rejects kind 27235. Tower retains user mapping, site allowlisting,
workspace creation, idempotency and billing authority.

## Owner provisioning

After an operator activates the reviewed Autopilot source, sign in as the real
managed-app owner and open **Secrets** (`/secrets`). Select the workspace holding
the existing site signing record. If it is not imported, use **Add secret**, type
**Nostr signing key**, to import it directly into protected custody. Check its
public identity against the approved site identity. Do not send the key through
chat, an agent, an app environment variable or a command line. Leave raw return,
agent and pipeline permissions off unless separately authorized.

On that record, choose **Authorize hosted signup**. Select the managed app,
review its stable ID and root, enter the exact HTTPS endpoint ending in
`/api/v4/flightdeck-pg/hosted/workspaces`, choose an expiry (1–90 days), and confirm
the narrow permission. The server validates the owner, current app registration,
custody revision and expected public identity before creating authority.

The result contains public grant metadata and a private capability-file path.
The server creates this file exclusively under its data directory's
`hosted-site-credentials/`, mode 0600, in a mode-0700 directory. The API and UI
never return the opaque credential itself. The signing key remains encrypted in
the imported-secret custody domain. Grant metadata is materialized into Dexie;
server listing recovers it after reload or browser cache loss.

The supported owner-only request is:

```http
POST /api/secrets/hosted-site-grants
Content-Type: application/json
```

```json
{
  "workspaceId": "local",
  "appId": "<registered-app-id>",
  "secretId": "<selected-imported-record-id>",
  "secretRevision": 1,
  "siteNpub": "<reviewed-site-public-identity>",
  "url": "https://hosted.example/api/v4/flightdeck-pg/hosted/workspaces",
  "expiresAt": 1800000000
}
```

Use the record's actual revision and a future expiry within 90 days. Browser
owner cookies authorize management. Delegated owners, bot/agent capabilities and
session tokens cannot mint these grants. Unknown input fields are rejected.

`GET /api/secrets/hosted-site-grants?workspace=<id>` lists public metadata;
`GET /api/secrets/hosted-site-grants/<grant-id>/audit` reads sanitized audit;
`DELETE /api/secrets/hosted-site-grants/<grant-id>` revokes authority immediately.
The UI exposes revoke and audit controls. Import replacement/revision changes,
import revocation, app removal, app owner/root changes and expiry also deny use.
Reauthorize explicitly after reviewing any of these changes; no automatic repair
or identity substitution occurs.

## Runtime contract

The app reads only the private opaque capability file. It calls the existing
Autopilot loopback listener at:

```text
POST /api/internal/signing/hosted-site/readiness
POST /api/internal/signing/hosted-site/attest
Authorization: Bearer <opaque-app-capability>
```

Readiness accepts `appId`, exact `url` and `siteNpub`, and exercises real custody.
Attestation accepts `appId`, `url`, `method: "POST"`, exact UTF-8 `payload`, its
SHA-256 `bodyHash`, `userEventId` and complete signed `userEvent`. The broker
checks all bindings, signature and 60-second freshness before signing its own
fresh event with `u`, `method`, `payload` and `user_event_id` tags. Only the
`workspace_name`, UUID `idempotency_key` and `terms_version: "hosted-usd-v1"`
payload is accepted, at most 2048 bytes.

This app capability accepts browser direct-user proofs without delegation or
`wm-session-capability` tags. This is a narrower local grant policy, not a
redefinition of Tower's identity mapping: Tower still decides the actor and
rejects workspace-key nomination independently. There is no generic URL,
event-signing method, key export or session-token borrowing.

The actual resolved peer and URL hostname must both be loopback. Missing peer
resolution fails closed; spoofed forwarding headers do not supply authority.
Credential possession is app-bound to the registered ID/root/owner; it is not
an OS sandbox against another process with the same filesystem/user authority.
Keep the credential outside browser/static roots and do not expose it in logs.

Replay state persists in a private SQLite database across process replacement.
Each user event can be attested once per grant within its full validity window;
fresh-proof retries retain the payload/idempotency key and let Tower decide
idempotency. Limits are 12 proofs per actor and 120 per grant per minute. Used
proofs are retained for 120 seconds; grant and custody audit records survive.
App lookup awaits are followed by revocation/expiry rechecks before signing.

## Activation and verification

Source/tests do not activate a running Autopilot process. Review the patch first,
then obtain explicit operator restart approval acknowledging interruption of
active sessions. Do not restart from a managed agent without that approval.
Owner provisioning is a separate authenticated action after activation.

Configure only the consumer's broker URL, credential-file path and public Tower
URL through managed app settings. Readiness proves custody and the consumer's
route probe, not Tower's site allowlist or completed signup. Verify allowlisting
with Tower authority, then perform one labeled signup and fresh-proof retry.
Report the workspace and billing/credit/ledger evidence; preserve payment test
mode. Replayed proofs must fail and fresh idempotent retries must not duplicate
workspace or welcome credit.
