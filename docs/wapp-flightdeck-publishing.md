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
must not query Flight Deck conversations or access a WApp database through
Autopilot.

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
