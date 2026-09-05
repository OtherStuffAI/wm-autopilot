# WApp to Flight Deck publishing

Autopilot keeps one stable installation identity per `WappRecord`. The existing
record `id` remains the compatibility identifier and is also exposed as
`wapp_installation_id`/`WAPP_INSTALLATION_ID`. The installation's current
public signing key is exposed as `publisher_npub`/`WAPP_PUBLISHER_NPUB`.
Private publisher material is never placed in the app registry, WApp SQLite,
managed-process environment, API response, or log. Autopilot's callback-only
signing broker briefly unwraps it only while producing a signature.

Tower owns publishing grants and activity projections. A WApp keeps its
canonical business record locally and publishes only a concise projection. It
must not query Flight Deck conversations through Autopilot. A managed
Tower-backed WApp may access only its own Tower app database namespace through
the installation-scoped local broker described below.

## Runtime variables

Autopilot injects these publishing variables in addition to the existing WApp
compatibility variables:

```text
WAPP_INSTALLATION_ID
WAPP_PUBLISHER_NPUB
WAPP_TOWER_URL
WAPP_WORKSPACE_ID
WAPP_TOWER_WORKSPACE_ID
WAPP_TOWER_WORKSPACE_OWNER_NPUB
WAPP_REGISTERED_OPEN_ORIGINS_JSON
```

`WAPP_WORKSPACE_ID` is empty when no stable Tower workspace ID is configured.
The absence of `WAPP_NSEC` is intentional. A WApp calls Autopilot's authorised
activity route; Autopilot signs with the installation-scoped broker identity.

Tower-backed WApps also receive these process-only values:

```text
WAPP_APP_NPUB
WAPP_TOWER_DB_BROKER_URL
WAPP_TOWER_DB_CAPABILITY
```

`WAPP_TOWER_DB_CAPABILITY` is an opaque bearer generated for that managed app
start. It is delivered through the one-time encrypted runtime envelope and is
not written to the app registry, WApp SQLite, PM2 ecosystem environment, argv,
logs, or API responses. Stop and restart revoke the previous process
capability. Autopilot restart also invalidates every capability because verifier
state is memory-only. Capabilities expire after 30 days of inactivity; each
accepted broker request renews that inactivity window.

## Own-app Tower database broker

The child sends a loopback request to `WAPP_TOWER_DB_BROKER_URL`:

```text
POST /api/internal/wapps/tower-db
Authorization: Bearer <WAPP_TOWER_DB_CAPABILITY>
Content-Type: application/json
```

```json
{
  "method": "PATCH",
  "path": "/tables/companies/rows/company_123",
  "body": {
    "set": {
      "status": "complete"
    }
  }
}
```

The broker accepts only `method`, `path`, and optional `body`. `path` is a
suffix beneath the bound installation's own Tower `/db` route; it is never a
URL. The broker constructs the Tower origin, workspace owner, app npub, and
namespace from current Autopilot state. Supported combinations are:

| Path | Methods |
| --- | --- |
| `/provision` | `POST` |
| `/migrations` | `GET`, `POST` |
| `/tables/:table/query` | `POST` |
| `/tables/:table/rows` | `GET`, `POST` |
| `/tables/:table/rows/:id` | `GET`, `PATCH`, `DELETE` |

Only the list route accepts `limit`, `offset`, `order_by`, and `order_dir`
query parameters. `POST` and `PATCH` require a JSON `body`; the broker
serializes it once, enforces a 1 MiB limit, hashes those exact UTF-8 bytes for
the NIP-98 payload tag, and sends the same bytes to Tower. `GET` and `DELETE`
reject bodies. Redirects are not followed. The child receives Tower's response
status, body, and `Content-Type`, but never the signed Authorization event.

The broker rejects non-loopback peers and non-loopback request hostnames,
unknown request fields, widened paths or methods, expired or revoked bearers,
inactive installations, missing custody or bindings, and any app identity or
Tower binding drift since process start. It is not a general NIP-98 signer or
HTTP proxy.

## One-time legacy identity custody migration

An existing Tower app namespace must keep its existing public app identity.
The loopback-only, Admin-authenticated migration route provides a one-time
bridge from an exact app-local env file into `WappStore` broker custody:

```text
POST /api/admin/wapps/legacy-custody-migration
```

Its JSON body contains only the exact app id, source file path, expected public
app npub, Tower binding id, installation metadata, `apply`, and optional
`autoStart`. There is deliberately no request field for `WAPP_NSEC`. The local
Autopilot process reads only that assignment from the named regular file inside
the registered app root. Requests with extra fields are rejected.

Use the dedicated CLI. It is a dry-run unless `--apply` is present:

```bash
bun clis/migrate-legacy-wapp-custody.ts <exact-app-id> \
  --source-env-file <absolute-app-root-env-file> \
  --expected-app-npub <existing-public-app-npub> \
  --installation-id <exact-installation-id> \
  --title <title> \
  --installation-owner-npub <owner-npub> \
  --created-by-npub <creator-npub> \
  --workspace-owner-npub <workspace-owner-npub> \
  --scope-id <scope-id> \
  --allowed-npub <owner-npub> \
  --allowed-npub <collaborator-npub> \
  --launch-url <url> \
  --tower-binding-id <binding-id>
```

Repeat `--allowed-npub` and `--registered-open-origin` as needed. Omit
`--auto-start` to preserve the current registry value; an explicit
`--auto-start true` or `--auto-start false` is the only way this command changes
it. Use the existing operator environment authentication (`WINGMAN_NSEC`) so
neither the operator key nor the legacy WApp key appears in argv.

Dry-run validates the registered app, safe script discovery, source path,
Tower binding, expected public identity, and any existing assignment without
writing. Apply creates or strictly verifies the exact assignment, verifies that
encrypted custody derives the same public npub, then atomically replaces the
source env file with only the `WAPP_NSEC` line removed. Every other byte and the
file mode are preserved. Only after custody verification and plaintext cleanup
does it clear `raw-signing-secret-removed-use-capability-broker`; unrelated
review reasons remain. A successful invocation can be rerun after the source
line is gone without rotating or duplicating the assignment.

Kindling's compatibility invariants for the reviewed migration are:

```text
app id: 64765f89-035a-4832-acba-b633068ba2e0
app npub: npub1x3khwkg426qrrlc25ekzg8k3l8y9hyut6fcxqkxpkm4d0ds45sdsqayt83
Tower binding: be7f5e54-becc-4283-aba6-d88d56e9f6ec
workspace owner: npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy
scope: bbfd13f9-1cdf-4f56-8213-cf0cffbe4d3c
```

The operator must supply the reviewed installation id, source file, launch
metadata, creator, and the complete Pete/Rick/Andy allowlist. The command
refuses metadata or identity drift rather than editing an existing assignment.

For records whose WApp assignment and custody are already complete, the
smaller review-only command remains available to re-discover structured
lifecycle scripts and clear only the obsolete broker review reason:

```bash
bun clis/appctl.ts review-wapp-tower-broker <app-id>
```

Other lifecycle review reasons remain in place and must be handled through
their existing review path. The review-only command does not re-enable
`autoStart`.

## Reusable client

`src/wapps/wapp-publishing-client.ts` implements the Tower as-built routes:

```text
GET  /api/v4/wapp-activity/workspaces/:workspaceId/grants/me
POST /api/v4/wapp-activity/workspaces/:workspaceId/items
```

The client refreshes its self-scoped grant at startup and on an interval,
caches the ETag and grant version, validates the installation and publisher
identity, and signs the exact URL, method, and serialized body hash. It retries
only transport/rate failures and reuses the identical serialized projection on
each attempt. Stable publisher/grant stale, disabled, revoked, and missing
errors trigger a grant refresh and remain failed rather than being hidden by a
fallback.

Generated WApps receive the same client source plus
`src/publishing-example.ts`. Start the client during application startup. Only
publish after the WApp has committed its canonical record; a publication retry
must not run the canonical business mutation again.

## Rotation

Ordinary WApp updates cannot replace a publisher key. Rotation uses the
dedicated admin action:

```text
POST /api/wapps/:wappInstallationId/rotate-publisher-key
```

The body must include `confirmWappInstallationId` equal to the stable
installation ID. The `stage` phase generates or imports a pending key, stores
it encrypted, and returns only `pendingPublisherNpub`; the current publisher
continues unchanged. After a Flight Deck administrator approves that public
key through Tower, the `activate` phase proves the pending key can read the
installation's active self-grant and only then promotes the broker identity.
The PG-native publishing grant is authoritative; activation does not depend on
the legacy workspace-app compatibility registry. The installation ID never
changes.

For the recovery case where the local broker key is absent but the Tower
installation and current public publisher identity still exist, the app CLI
performs those three phases without exposing signing material:

```bash
bun clis/appctl.ts wapp-publisher-repair <wapp-installation-id> --bot-crypto
```

The command stages a generated key in broker custody, reads Tower's current
grant, requests the exact Tower publisher rotation when required, and activates
the already-approved pending key locally. It stops on identity drift.

## At-rest boundary

The file broker is transitional local custody: AES-256-GCM envelopes and their
0600 master wrapping key both live beneath `data/broker-vault`. This removes
plaintext keys from JSON, SQLite and child processes, but does not protect
against compromise of the Autopilot OS account. `WappSigningBroker` accepts a
`BrokerKeyVaultBackend`; production hardening can supply an OS-keychain, TPM,
HSM or external-secret-provider backend whose wrapping key is not stored beside
its envelopes. Unknown configured backends fail closed.

## Read-only publisher readiness

Preflight must use actual signing custody and Tower's publisher-self grant read.
Neither installation metadata, `hasAppSigningKey`, nor a human-signed
`grants/me` response proves publisher readiness. Use:

```text
GET /api/wapps/:installationId/publisher-readiness?scope_id=...&channel_id=...&origin=...
GET /api/owners/:ownerNpub/wapps/:installationId/publisher-readiness?scope_id=...&channel_id=...&origin=...
```

All three query parameters are required, each exactly once. `origin` must be
an exact HTTP(S) origin, without a path or trailing slash. Unknown parameters
are rejected. NIP-98 signs the exact external URL including query and `GET`;
owner routing occurs after verification. The direct route accepts the same
installation-bound scheduled execution authority as installation reads and
activity publishing, or existing AppsManage authority. The owner route uses
`wapps:read` delegation and its existing owner, installation, workspace and
scope resource filters. This adds no signing-key export or arbitrary proxy.

Authorized checks return HTTP 200 and `Cache-Control: no-store`, including when
readiness fails. Invalid input returns 400; existing auth/not-found boundaries
remain 403/404. The response is:

```json
{
  "ready": true,
  "code": "ready",
  "installationId": "installation-uuid",
  "checkedAt": "2026-09-05T04:15:00.000Z",
  "evidence": {
    "installationActive": "passed",
    "noPendingPublisher": "passed",
    "signingIdentity": "passed",
    "grantIdentity": "passed",
    "grantActive": "passed",
    "capability": "passed",
    "origin": "passed",
    "destination": "passed",
    "configuredPublisherNpub": "npub1...",
    "signingNpub": "npub1...",
    "grantVersion": 1,
    "towerStatus": null
  }
}
```

Checks are `passed`, `failed`, or `not_checked`; early failures never imply
success for unchecked evidence. Common failure codes include
`installation_not_active`, `publisher_rotation_pending`,
`publishing_configuration_missing`, `publisher_custody_unavailable`,
`publisher_identity_mismatch`, `grant_identity_mismatch`, `grant_not_active`,
`capability_not_granted`, `origin_not_granted`, `destination_not_granted`,
`grant_invalid`, and `transport_error`. Unrecognized upstream errors become
`tower_grant_read_failed`; upstream bodies, vault errors, keys and authorization
events are never returned. `towerStatus` is populated for Tower HTTP failures.

Autopilot opens existing protected custody, signs and locally verifies the
NIP-98 event, compares its actual public identity to the configured publisher,
and makes a fresh publisher-signed GET to Tower's `grants/me` with redirects
disabled. It checks installation, workspace, active grant, `activity.publish`,
origin and exact scope/channel. Local scope and registered origins must also
match. No timers, mutation, Feed probe, rotation or publication occur.

```bash
bun clis/appctl.ts wapp-publisher-readiness <installation-id> \
  --scope-id <scope-id> --channel-id <channel-id> --origin https://wapp.example \
  --bot-crypto --json
```

Add `--owner <owner-npub>` for owner-delegated management. CLI exit code is 0
only for `ready: true`, and 1 for not-ready or request errors. Readiness is a
point-in-time observation; Tower still authorizes every eventual delivery.
Source tests do not establish readiness of a running installation.

Successful responses also include `grant`, containing only the verified public
grant identity/version, status, capabilities, destinations and registered origins.
This supports grant-inspection clients without requiring the agent to sign as
the publisher. Unknown upstream fields are not forwarded. A matching destination
with `available: false` does not pass readiness.
