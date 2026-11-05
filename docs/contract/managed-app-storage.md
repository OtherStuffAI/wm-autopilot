# Managed-app remote storage, protocol v1

This is a private ciphertext-chunk storage contract for an explicitly delegated
installed app. Tower owns objects, authorization, budgets and transfers.
Autopilot owns process-scoped control capabilities. The app owns encryption,
scheduling, manifests and restore decisions. It is disabled until both operators
configure matching grants. Existing storage and signing APIs are unchanged.

## Identity and grants

The data-plane signer is the installation's stable `appNpub`, held by the
existing WApp signing vault. The managing profile bot remains the operator;
shared profile, human owner and Wingman instance identities are refused as app
signers. Apps receive an opaque runtime capability and may read the narrowly bound historical prepare proof described below; they never receive private keys or arbitrary signing authority. Agent-session credentials and browser keys are not used.

Autopilot requires an active owner-bound installation and existing per-install signing custody. Existing local WApp vault identities are supported without a Tower app DB binding; `towerBindingId` must be present as either the exact existing ID or null. The storage broker never provisions keys. No implicit provisioning or first-workspace
selection occurs. Identity/binding drift denies requests. Publisher rotation is
blocked at store update, stage and activation while a local storage grant exists; v1 has no identity migration.
Removing a grant to rotate a key can make old archives inaccessible. Preserve
the signing identity needed to restore them.

`WAPP_REMOTE_STORAGE_GRANTS_FILE` points to an operator-maintained JSON file:

```json
{
  "version": 1,
  "grants": [{
    "grantId": "backup-destination",
    "revision": "1",
    "installationId": "<installed WApp ID>",
    "appId": "<managed app ID>",
    "ownerNpub": "<installation owner npub>",
    "appNpub": "<unique installation signer npub>",
    "towerBindingId": null,
    "origin": "https://destination.example",
    "serviceNpub": "<destination Tower service npub>",
    "workspaceId": "<destination workspace UUID>",
    "delegationId": "<destination delegation UUID>",
    "expiresAt": "<explicit ISO expiry>",
    "maxObjectBytes": 8388608,
    "billing": "operator_budget"
  }]
}
```

Tower independently requires `MANAGED_APP_STORAGE_GRANTS_FILE`:

```json
{
  "version": 1,
  "grants": [{
    "delegationId": "<same delegation UUID>",
    "revision": "1",
    "origin": "https://destination.example",
    "serviceNpub": "<this Tower's configured service npub>",
    "workspaceId": "<existing workspace UUID>",
    "workspaceOwnerNpub": "<current workspace owner npub>",
    "installationId": "<same installed WApp ID>",
    "appId": "<same managed app ID>",
    "appNpub": "<same unique installation signer npub>",
    "expiresAt": "<explicit ISO expiry>",
    "maxObjectBytes": 8388608,
    "quotaBytes": 1073741824,
    "maxObjects": 10000,
    "billing": "operator_budget"
  }]
}
```

There is no default destination, wildcard, credential fallback or HTTP/FIPS
fallback. `origin` is an exact HTTPS origin with no trailing slash, path, query,
fragment or credentials. V1 data transfers use this same origin. Changing a
local grant requires a managed app restart; changing a destination revision
invalidates issued stream tokens, not existing object ownership.

Files are read on every operation; one malformed grant disables the whole storage file. Expected configuration failures leave managed apps running without a storage capability and inject `WAPP_REMOTE_STORAGE_ERROR`; the typed reason is logged and must be surfaced before scheduling. Broker requests still fail closed. Use regular
files, mode `0600` or `0400`, owned by the effective server UID, not symlinks.
For container bind mounts, chown the host file to the numeric UID seen inside
the container. Store configuration outside Git and mount it read-only. Managed
apps sharing the host UID are trusted local processes, not OS-sandboxed tenants:
the local consent file and process environment do not isolate a compromised
same-UID process. Independent destination delegation remains required.

## Control and data planes

Managed starts inject `WAPP_REMOTE_STORAGE_BROKER_URL`,
`WAPP_REMOTE_STORAGE_CAPABILITY` and `WAPP_REMOTE_STORAGE_BINDING_JSON` through
the encrypted runtime envelope. The envelope is removed after launch; the token
then exists in app process memory/environment and inherited subprocesses.
Build/setup receives no storage capability. Stop, restart and failed start
revoke it. Host restart invalidates tokens even if PM2 apps survive: a
`401 capability_invalid` with `action: managed_restart_required` means park
scheduled runs and surface the need for a managed restart. No automatic renewal
across a host restart is claimed. Successful control calls renew a 30-day idle
lease, bounded by grant expiry.

The loopback-only `POST /api/internal/wapps/remote-storage` uses Bearer auth,
JSON and a 16 KiB request/response limit. Four strict request shapes:

```json
{"operation":"status"}
{"operation":"prepare","idempotencyKey":"<UUID>","sha256":"<ciphertext hex SHA256>","sizeBytes":123}
{"operation":"status","objectId":"<UUID>"}
{"operation":"status","cursor":"<opaque list_cursor or next_cursor>"}
{"operation":"complete","objectId":"<UUID>"}
{"operation":"download-url","objectId":"<UUID>"}
```

`status` without `objectId` or `cursor` reports delegation capacity, billing state and an opaque `list_cursor`. Use it in paged status requests to discover up to 50 completed objects belonging to the exact grant owner tuple. Pages return `objects` (identity fields only) and `next_cursor` (string or null). Cursor is not authority: workspace/delegation and every owner field are rechecked. Keyset pagination preserves exact PostgreSQL timestamp precision. Pages are discovery, not a point-in-time snapshot; repeat a sweep if uploads complete concurrently.
Key presence discriminates the union: null/empty IDs or cursors are rejected. `objectId` and `cursor` are mutually exclusive. Callers
cannot choose URLs, methods, workspaces, owners, headers, publicity or blob
bodies. Autopilot checks the exact service identity from HTTPS `/health` and
`GET /api/v4/managed-app-storage/descriptor` before a signed control request;
no redirect is followed. Health pins the identity served by the configured TLS
origin, not an independent cryptographic attestation.

Tower routes are below:

```text
/api/v4/managed-app-storage/workspaces/:workspace/delegations/:delegation
POST /status
POST /prepare
POST /objects/:object/status
POST /objects/:object/complete
POST /objects/:object/download-url
PUT  /objects/:object/upload
GET  /objects/:object/download
```

Control POSTs require strict fresh (60 second) NIP-98 bound to exact URL, method
and raw JSON hash, using the raw app signer without workspace-key alias
resolution. Body fields are `installation_id`, `app_id`, `revision`,
`expected_service_npub`, plus prepare's `idempotency_key`, `sha256_hex` and
`size_bytes`; paged delegation status also accepts `cursor`. Workspace/service/owner/grant checks precede object access.
Object ownership is immutable `(workspace, delegation, installation, app,
signer)`; budget or expiry revisions preserve access to existing objects.

Every successful control response includes `protocol`, `service_npub`,
`workspace_id`, `delegation_id`, `installation_id`. Object responses add
`object_id`, `state` (`pending`, `uploaded`, `complete`), `sha256_hex`,
`size_bytes`, `verified_at`. Status is a ledger record, not a fresh durability
or source-provenance proof. Object status also returns `publisher_receipt` as described below. Prepare pending responses add `upload`;
download-url adds `download`. Each descriptor has `url`, `method`,
`expires_at` and `headers` containing `X-Managed-Storage-Token`. Upload also
requires exact `Content-Type: application/octet-stream` and `Content-Length`.
The URL has no bearer token in its query/path.

The app sends ciphertext directly to Tower's bounded stream endpoint using
those headers. **These are destination-issued tokenized transfer URLs, not
S3 presigned PUTs.** Bun's current S3 presigner cannot constrain size/checksum
or prevent overwrite after completion. Bytes never traverse Autopilot's broker.
Tower uses private internal S3 URLs with abortable IO; those URLs and S3
credentials never leave Tower. Never log transfer token headers.

## Integrity, capacity and revocation

Chunks are at most 8 MiB; choose smaller chunks for slow links. Each transfer
has a 15 second deadline; authenticated admission allows two concurrent
transfers per Tower process and one per delegation. Invalid tokens cannot take
slots. Tower reads bounded bytes, checks exact size/hash before writing, and
rechecks grant, token and credits under an object lock. Complete re-reads and
hashes persisted bytes before marking verified; old upload tokens cannot write
completed objects. Retry PUTs can only write identical validated ciphertext to
the fixed private key. A failed SQL commit retains the reservation and the
same-key retry cannot accumulate unaccounted keys.

Prepare reserves declared bytes and an object row durably and atomically,
including pending uploads and the stored receipt metadata (`receipt_bytes`, at most 6144 per object). Capacity planning must include both ciphertext and receipts; status/descriptor advertise `max_receipt_bytes`. `(workspace, delegation, idempotencyKey)` is unique;
same identity reconciles, changed hash/size conflicts. Lost upload/complete
responses reconcile through status before retrying. Token reissue replaces the
prior token; replayed control requests cannot create a different object or
identity but can replace a token. There is no generic signing or delete API.
No automatic retention pruning is claimed; budget exhaustion requires operator
action. Revocation denies new controls/transfers; an accepted response already
handed to the HTTP stack may finish. Issued tokens expire in at most 60 seconds
and are checked against current authority whenever opened. Download tokens are reusable during that interval; the broker tolerates up to five seconds of positive clock skew while the destination still enforces its own 60-second expiry.

Delegation status exposes `remaining_bytes`, `remaining_objects`,
`max_object_bytes`, `billing_ok`, `billing: operator_budget` and
`budget_mode: operator_allocated_unmetered`. This explicit operator consent is
mandatory, including on hosted Tower: it deliberately grants **unmetered**
archive space. Existing hosting write blocks by workspace UUID and legacy
credit blocks still deny prepare/upload/complete; reads remain available.
Archive bytes are excluded from existing usage/billing snapshots. The initial legacy credit preflight can persist depletion state; a new legacy state transition detected only by the final in-transaction check rolls back with a rejected write and is persisted on the next preflight. Writes are still denied. V1 does not
support automatically metered hosting storage; no price/tariff is changed.
Operators must allocate real capacity and accept costs before scheduling.

Errors distinguish local capability/restart failures, destination
`storage_delegation_denied`, `storage_credits_required` (402),
`storage_budget_exhausted`/`storage_idempotency_conflict`/
`storage_identity_mismatch` (409), bounds (413), and busy (429). Stop scheduled
retry storms for revoked, credit-blocked or exhausted allocations. Never expose
raw provider error bodies or credentials.

Object status returns `publisher_receipt: {event, body, accepted_at}`: the
original accepted prepare NIP-98 event, exact signed JSON body and acceptance
UTC timestamp. It is stored only when inserting the object, never replaced by
idempotent retries; SQL guards make object identity and receipt immutable.
Authorization headers are capped at 4 KiB and prepare JSON at 2 KiB. Receipt
metadata counts against quota. Pages contain identities only; retrieve proofs
by object status to keep control responses under 16 KiB.

This is an explicit exception to withholding signing proofs: it returns only
the app's already accepted, body-bound prepare proof, not a signer endpoint.
During its 60-second freshness window, replay can only reconcile that same
immutable identity (and rotate an upload token); afterwards it is stale as
HTTP authorization. Do not log it as a credential. Historical verification
checks the signature, expected installation publisher, raw-body hash, exact
prepare URL (origin/workspace/delegation), app/installation/service, ciphertext
hash/size/idempotency and the recorded acceptance-time window. It deliberately
does not require freshness at restore time or the grant's current revision.

For a manifest object, the proof commits the expected app publisher to its
encrypted bytes and metadata inside them. It does not independently authenticate
the physical provider's acquisition or prove snapshot consistency. Trusted
restore must separately verify the manifest's source identity/consistency and
its source-authorized commit requirements. No arbitrary signing is provided.
Fresh-catalog recovery requires restoring the existing app signer custody (or
a separately reviewed operator identity migration); a lost local SQLite catalog
can be rebuilt through pages and proofs, but new keys cannot silently adopt
another installation's objects. No supported off-Mini signer-custody bootstrap has been verified in this delivery. An owner-authorized read-only recovery grant or explicit identity migration remains an unresolved design gate for loss of the Mini; do not export raw signing keys or claim complete disaster recovery.

## Activation and source validation

1. Review source/schema changes and deploy/restart Tower and Autopilot through
   their operators; source installation alone does not activate routes.
2. Preserve the installed app identity and configure the exact owned destination,
   matching grants, private bucket policy, capacity (including receipts), credits and operator budget. Rate-limit dedicated upload/download paths at the proxy.
3. Restart the managed app to obtain a fresh capability, then verify status,
   private chunk upload/complete/read-back, wrong-workspace denial and revocation
   on an isolated destination. Do not enable schedules before preflight succeeds.
4. Separately prove coherent source acquisition, encryption/escrow, authenticated
   commit provenance, isolated restore and off-source recovery. Storage support
   alone is not a completed backup.

Tower: `bun test tests/managed-app-storage.test.ts` creates its own disposable
PostgreSQL cluster with a private socket and no TCP listener (`initdb`, `pg_ctl`
on PATH, or `TEST_POSTGRES_BIN`); its blob adapter is a fixture, not live S3.
Autopilot: `bun test src/wapps/remote-storage-broker.test.ts` and
`bun test src/apps/app-storage-lifecycle.test.ts`. Existing app DB and lifecycle
regressions remain relevant. Production storage, proxies, mounts and managed
restarts require activation smoke tests; no production destination is assumed.

A malformed grants file also blocks identity/binding edits with `storage_config_invalid`; repair the operator file before retrying. Source schema is additive at activation; disposable fixture databases must be recreated when testing earlier source snapshots. Recovery runs health/descriptor checks per call; retrieve receipts for manifest objects and use their authenticated chunk hash lists to avoid unnecessary per-chunk proofs.
