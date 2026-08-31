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

For an app record migrated from legacy `WAPP_NSEC` configuration, an operator
can re-discover structured lifecycle scripts and clear only the obsolete
broker-migration review reason after confirming the WApp has a complete Tower
assignment:

```bash
bun clis/appctl.ts review-wapp-tower-broker <app-id>
```

Other lifecycle review reasons remain in place and must be handled through
their existing review path. The command does not re-enable `autoStart`.

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
