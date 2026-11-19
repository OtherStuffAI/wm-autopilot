# Registered app private storage

Source contract: `registered-app-storage-v1`. This capability is separate from
the operator-delegated managed archive protocol. It requires no storage grant
file or static storage environment configuration. Tower must implement the same
registered-app API before transfers work; a source update alone is not activation.

## Authority and lifecycle

Managed start issues a random, process-only bearer capability for the existing
active Tower-backed WApp installation and its assigned active installations for
the same managed app. Each binding fixes the installation, app record, owner,
workspace owner, Tower origin, binding ID, workspace ID and app signing npub.
The signer stays in existing encrypted WApp custody; only the broker's callback
can use it. Owner, workspace-owner, instance, bot/profile and shared active app
signers are rejected. No namespace merging or data migration occurs.

Every operation checks current installation state and identity, then calls the
signed Tower descriptor. Tower checks the exact raw app signer and enabled
owner-approved registration for every lifecycle operation. Ordinary app users
need no Tower membership; the app backend must enforce participant/design ACLs.
An assigned installation capability authorizes that app namespace, not one user
or one design. The broker accepts an object UUID only through that namespace's
signed metadata route, checking owner/app/object binding before transfer.

Stop, replacement, failed start and managed restart revoke prior capabilities.
Expiry is 30 days from issue; the next managed start issues fresh authority.
Changing or removing any assigned installation binding invalidates the capability.
Build/setup receive no capability. Tokens are stripped from persisted app config
and excluded from process-manager metadata; only the transient runtime envelope
passes them to the process. Host restarts also discard capabilities. Runtime
errors surface as `WAPP_REGISTERED_APP_STORAGE_ERROR`; consumers must fail closed.

## Server-only consumer SDK and configuration

`createRegisteredAppStorageClient` in
`src/wapps/registered-app-storage-client.ts` accepts an environment record and
optional fetch implementation. It returns `{ bindings, request(input, signal?) }`;
`request` returns a `Response`, so consumers must inspect `response.ok` and errors.
Never send this environment or SDK authority to a browser.

Managed start injects:

| Variable | Value |
| --- | --- |
| `WAPP_REGISTERED_APP_STORAGE_BROKER_URL` | `http://127.0.0.1:<autopilot-port>/api/internal/wapps/registered-app-storage` |
| `WAPP_REGISTERED_APP_STORAGE_CAPABILITY` | Process-only bearer token |
| `WAPP_REGISTERED_APP_STORAGE_BINDINGS_JSON` | JSON array of the bindings below |

Each binding has exactly these public configuration fields:

```ts
{
  installationId: string;
  appId: string;
  ownerNpub: string;
  workspaceOwnerNpub: string;
  appNpub: string;
  bindingId: string;
  workspaceId: string | null;
  origin: string;
  protocol: "registered-app-storage-v1";
  maxObjectBytes: 8388608;
}
```

The local transport is `POST` to the broker URL, with
`Authorization: Bearer <capability>` and `Content-Type: application/json`:

```ts
{
  installationId?: string; // omitted means the default managed installation
  method: "GET" | "HEAD" | "POST" | "PUT";
  path: string;           // only paths in the table below
  body?: unknown;        // absent for GET/HEAD; exact keys below otherwise
}
```

```ts
const client = createRegisteredAppStorageClient();
const response = await client.request({
  installationId: selectedInstallationId,
  method: "POST",
  path: "/prepare",
  body: {
    idempotency_key: durableRetryUuid,
    file_name: "attachment.png",
    content_type: "image/png",
    size_bytes: bytes.length,
    sha256_hex: sha256Hex,
  },
});
if (!response.ok) throw new Error(`Storage prepare failed (${response.status})`);
const prepared = await response.json();
```

Persist the idempotency UUID with the app's pending upload before requesting
prepare. Retry the same UUID and identical metadata after an uncertain response;
changed metadata conflicts. Complete retries are exact and idempotent. Uploaded
bytes must match prepared size/hash. Completed objects cannot be overwritten.

## Exact Tower wire mapping

The broker signs the exact method, URL and serialized payload with NIP-98.
All targets are constructed from the installation binding:

`<origin>/api/v4/workspaces/<workspaceOwnerNpub>/apps/<appNpub>/storage`

| Method | Relative path | JSON body |
| --- | --- | --- |
| GET | `/descriptor` | absent |
| POST | `/prepare` | `{idempotency_key,file_name,content_type,size_bytes,sha256_hex}` |
| PUT | `/objects/:objectId` | `{base64_data}` |
| POST | `/objects/:objectId/complete` | `{size_bytes,sha256_hex}` |
| GET | `/objects/:objectId` | absent |
| GET, HEAD | `/objects/:objectId/content` | absent |

The signed descriptor must return `protocol`, `workspace_owner_npub`, `app_npub`,
`private_only:true`, integer `max_object_bytes` no larger than 8388608, and
`operations:["prepare","upload","complete","metadata","content","head"]`.

Prepare, upload, complete and metadata responses contain:
`protocol`, `workspace_owner_npub`, `app_npub`, `object_id`, `file_name`,
`content_type`, `size_bytes`, `sha256_hex`, `is_public:false`, `completed_at`.
The broker validates and allowlists these fields; extra provider credentials or
URLs are never forwarded. `completed_at` is null until verified completion.

Tower GET content returns raw bytes. The broker buffers at most 8 MiB, verifies
size and SHA-256 against freshly signed metadata, then returns the same metadata
plus `bytes_base64` as JSON. Logical HEAD returns no body with verified metadata-derived
`Content-Type`, `X-Storage-Size-Bytes` containing the object size, and `Content-Length: 0`.
The local HTTP transport is POST, so a nonzero content length with an empty body
would be invalid framing. Tower's actual signed HEAD remains unchanged. All broker responses use
`Cache-Control: private, no-store`. No bearer download ticket or provider URL is
accepted or returned. Content is buffered intentionally to verify bytes before
release; signed upstream streams are read with byte and time bounds.

Objects are 1..8 MiB. Base64 must be canonical and decode to no more than 8 MiB;
the local JSON envelope is capped at 12 MiB, including chunked input. Control
responses are capped at 16 KiB. Requests time out after 15 seconds, cancel stalled
streams and reject redirects. UUIDs and lowercase SHA-256 hex are validated;
unknown body/envelope fields, query strings, arbitrary URLs, publication paths,
foreign installations and caller-supplied authority are rejected.

Errors are JSON `{error:<code>}` with a failing HTTP status. Invalid/expired
process capabilities include `action:"managed_restart_required"`; the operator
must perform any required restart outside the managed session under explicit
restart authority. Registration denial and namespace errors remain failures.
Consumers must not fall back to another signer or storage namespace.

## Verification and activation

Run exact paths with a leading `./` to avoid matching archived fixtures:

```sh
bun test ./src/wapps/registered-app-storage-broker.test.ts
bun test ./src/apps/app-storage-lifecycle.test.ts
bun run typecheck
```

Broker tests use disposable SQLite custody stores, real loopback HTTP and a signature-verifying
Tower fixture. They cover private lifecycle, replay/conflict, byte integrity,
foreign object/installation denial, registration disable, protocol identity,
redirect denial, response filtering, body bounds, cancellation, expiry and
binding drift. Lifecycle tests stub process execution and verify issuance,
replacement/revocation and setup exclusion. They do not prove live Tower/S3
behavior. Tower's isolated signed HTTP/database/S3 suite and consumer ACL tests
must pass separately. Shared activation, managed app refresh and live private
byte/native-image smoke tests require operator-approved runtime actions.
