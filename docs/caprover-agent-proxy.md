# CapRover agent proxy

A separate Bun service on the Autopilot machine exposes a single configured
CapRover target to exactly one configured Nostr npub. It reuses `CaproverClient`
and the shared NIP-98 verifier. It does not mount Autopilot's existing
`/api/caprover` handler and does not need an Autopilot restart.

## Contract

Prefix: `/api/agent/caprover`. All routes below require NIP-98. Query parameters
are unsupported: their exact bytes are authenticated first, then rejected.
Responses are JSON with `Cache-Control: no-store`.

| Method | Path relative to prefix | Input / output |
| --- | --- | --- |
| GET | `/target` | Target name, connectivity and app count; contacts target |
| GET | `/apps` | Safe app metadata for the selected target |
| GET | `/apps/:name` | Safe app detail, env **keys** only |
| POST | `/apps` | `{appName, hasPersistentData?: boolean}`; 201 on creation |
| POST | `/apps/:name/deploy` | `{imageName}` OR `{captainDefinition: {schemaVersion: 2, imageName}}` |
| GET | `/apps/:name/status` | `isAppBuilding`, `deployedVersion`; no invented success state |
| GET | `/apps/:name/logs` | Last 100 proxy operation records, newest first; raw output withheld |
| GET | `/apps/:name/deployments` | Last 100 upstream versions: version number and timestamp only |
| PATCH | `/apps/:name/config` | Any nonempty subset of bounded fields below |
| POST | `/apps/:name/domains` | `{action: "add" \| "remove" \| "enable-https", domain}` |
| POST | `/apps/:name/https` | `{}`; enable default-domain HTTPS |

`GET /health` is the sole unauthenticated endpoint, outside the API prefix. It
returns only `{service, ready}` with 200 or 503. Readiness means configuration is
complete; it is **not** a CapRover connectivity check. Use authenticated `/target`
for that. No CORS, cookie auth, npub-header auth, DELETE, untrack, generic URL proxy,
server administration or command execution is available.

### Inputs and limits

- App names: 1–50 characters, lowercase letter first, lowercase alphanumeric
  segments separated by hyphens. These limits deliberately exclude some legacy names.
- Target selection is operator configuration only; no request can change it.
- Image refs: conservative Docker-style registry/repository, optional tag or
  `@sha256:<64 lowercase hex>`; at most 256 characters. No URL scheme or credentials.
- Captain definitions support **imageName only**. Dockerfiles, source archives,
  template IDs and arbitrary build instructions are excluded.
- Config: `instanceCount` integer 0–20; `containerHttpPort` integer 1–65535;
  `forceSsl` boolean (true requires default-domain HTTPS already enabled).
- `envVars`: complete replacement array, at most 100 unique shell-style keys
  (128 characters), string values at most 8192 characters. `[]` clears env vars.
  Omitted env vars stay unchanged. Secret values are accepted on writes but never
  returned, logged, or copied into the proxy journal.
- `volumes`: complete replacement array, at most 10 named volumes. Names must
  start with `<appName>-`, at most 100 lowercase letters/digits/hyphens;
  container paths are absolute, at most 256 characters, with simple alphanumeric,
  underscore and hyphen segments. No root path, traversal, host bind mounts or
  duplicate mount paths. The app must have been created with persistent data.
  `[]` clears mappings. Published host-port settings are intentionally excluded
  because they can conflict with host services. Existing port metadata is readable.
- Domains: lowercase DNS names, at most 253 characters, no wildcard, IP address,
  scheme or path. HTTPS requires the usual CapRover DNS prerequisites.
- Every JSON object rejects unknown fields. Body limit: 128 KiB including
  streaming bodies. Authorization header limit: 16 KiB.
- Each request performs one mutation. Requests are serialized within a process;
  use one process per target. Do not concurrently edit the same app in other
  tools. PATCH preservation prevents omitted-field resets; there is no upstream
  revision/CAS contract across external editors.

### Differences from the existing integration

Raw build/runtime output can contain env values, registry credentials, or secrets
not known to the proxy. It is therefore **never fetched or exposed**. `/logs`
returns durable operation metadata (`operation`, `startedAt`, `completedAt`,
`state`, `id`) and an explicit `withheld` notice. Trusted administrators can view
raw logs directly in CapRover. The journal records no input or error text.
A crashed operation remains `started`; an upstream error is `outcome-unknown`.
Inspect status/history before retrying: timeouts do not prove deployment failed.

History is CapRover's native `versions`, not Autopilot's tracked-app history.
Image names/git metadata are omitted from history to avoid arbitrary secret-bearing
strings. Missing build status/history yields 502 rather than an empty invented state.
The proxy does not create local Autopilot tracking records, so no untrack path exists.

Bounded config uses upstream **PATCH** `/api/v2/user/apps/appDefinitions/update`.
The older POST route resets omitted fields. If the installed CapRover lacks PATCH,
config requests fail; there is no POST fallback. Verify target compatibility during
activation. See upstream [partial-update implementation](https://github.com/caprover/caprover/blob/master/src/handlers/users/apps/appdefinition/AppDefinitionHandler.ts)
and [router](https://github.com/caprover/caprover/blob/master/src/routes/user/apps/appdefinition/AppDefinitionRouter.ts).

Errors: 400 invalid JSON/fields/query, 401 invalid authorization, 404 unknown route
or app, 405 unsupported method, 409 state conflict, 413 size limit, 415 media type,
503 incomplete operator configuration, 502 upstream failure/inconsistent response.
Upstream error text is never returned because it may contain secrets. A mutation
response means the client call completed; use status/history to inspect deployment
state. Proxy client requests have a 30-second deadline and reject redirects.

## Authentication and intermediary rules

Use `Authorization: Nostr <base64 signed event JSON>`. Only kind 27235 with a valid
signature from `CAPROVER_AGENT_ALLOWED_NPUB` is accepted. The verifier checks one
exact `u` tag, one exact uppercase `method` tag, age no older than 60 seconds and
future skew no greater than 15 seconds. A nonempty body requires exactly one
`payload` tag equal to SHA-256 of the **exact transmitted bytes**. Missing,
duplicate and incorrect tags fail. Bodyless requests must have no payload tag.
Mutation JSON must be nonempty. Sign each request separately.

The service listens only on `127.0.0.1`. Configure the exact external origin
using `CAPROVER_AGENT_PUBLIC_ORIGIN` (HTTPS, or loopback HTTP for local operation).
The signed URL is that origin plus the incoming pathname and complete query.
`Host`, `Forwarded` and `X-Forwarded-*` never select the signing origin. A trusted
reverse proxy must preserve path/query without rewriting or normalization and
route a dedicated hostname to this service. Do not forward its traffic to the
broad Autopilot API, and do not mount this service beneath a rewritten prefix.

Event IDs are admitted atomically in durable SQLite before dispatch, including
unsupported requests. Reuse is denied across processes/restarts until expiry.
Wrong signers do not consume cache entries. A full/unavailable replay cache denies
access. Persist the state directory; never run one public origin with separate
replay databases. Only one service process is supported for mutation ordering.

## Managed app integration and activation

Reusable managed-app root: `apps/caprover-agent-proxy`. Its package scripts expose
`start`, `build` and `test` to Autopilot's safe lifecycle-script discovery. `start`
runs the Bun source so it does not depend on a stale build. `build` bundles for
validation into ignored `tmp/build/caprover-agent-proxy`; it does not deploy.

Operator configuration, supplied through the managed app's private environment:

| Variable | Requirement |
| --- | --- |
| `CAPROVER_AGENT_ALLOWED_NPUB` | Exact approved npub; unset/invalid keeps every API caller denied |
| `CAPROVER_AGENT_PUBLIC_ORIGIN` | External origin, no path/query/credentials |
| `CAPROVER_AGENT_TARGET` | Explicit existing target name, e.g. `primary` |
| `CAPROVER_AGENT_PORT` | Available loopback port, integer 1024–65535 |
| `CAPROVER_AGENT_STATE_DIR` | Private persistent writable directory; replay/journal/log files |
| CapRover credentials | Existing target environment described below; HTTPS target origin only |

Primary target uses existing `CAPROVER_URL`/`CAPROVER_PRIMARY_URL` and existing
login/password env conventions (`CAPROVER_PASSWORD`, `CAPROVER_LOGIN_CODE`,
legacy `LOGIN_CODE`, or primary-specific names). Other targets use
`CAPROVER_<TARGET>_URL` and `CAPROVER_<TARGET>_PASSWORD`/`LOGIN_CODE` with
`CAPROVER_TARGETS` listing them. Supply only the intended target's configuration
and no unrelated Autopilot secrets. Credentials stay inside the client.
Missing target/credentials, invalid target URL, origin or npub keeps the API closed.
Invalid port/state directory prevents process startup explicitly.

Activation procedure:

1. Obtain the exact approved npub and a designated disposable test app from the
   operator. Confirm installed CapRover supports partial config PATCH.
2. Choose an unused port and private state directory. Register this root with
   Autopilot using the existing owner-authorized managed-app flow; keep autoStart
   off until configuration is reviewed. For a broker-authorized agent:
   `bun clis/appctl.ts register caprover-agent-proxy --directory <repo>/apps/caprover-agent-proxy --bot-crypto`.
   Record the returned actual app ID; use it for later lifecycle commands.
3. Set the managed app's private environment through the existing authorized app
   settings flow. Do not place CapRover passwords in command arguments, docs or Git.
4. Build/test via the managed app, then start **only this app**. No Autopilot
   restart is required. Bind a dedicated reverse-proxy hostname if remote access
   is required; preserve the signed path/query and keep loopback binding.
5. Verify `/health`, unsigned denial, wrong-signer denial and an approved-signer
   `/target` using broker signing. Mutating live smoke tests require the designated
   test app; do not create/deploy/configure production apps as validation.
6. Inspect test app creation, deployment, status/history, config preservation and
   HTTPS/DNS prerequisites with the operator. App deletion remains outside the API.

Until the approved npub is supplied, there is no active caller. Source validation
and local fake-server tests do not constitute live activation.

## Broker-signed agent example

The authorized agent needs an operator-provisioned signing capability whose signer
is the approved npub and whose host/method/path scope includes this service.
Use the session capability broker through `clis/wingman-capability.ts`, never raw
private keys or a human signer. The CLI uses `WINGMAN_URL`, `SESSION_ID` and the
runtime-provided `WINGMAN_CAPABILITY`. Do not copy these credentials into source
files or command arguments. Its JSON output has `authorization` (the complete
Nostr header value) and `signedBy` (the signer identity). Confirm that identity
matches the operator-approved npub before activation.

```bash
# body.json must be private and contain the exact JSON bytes to transmit.
CAPROVER_REQUEST_URL="https://<configured-proxy-host>/api/agent/caprover/apps"
CAPROVER_AUTH_HEADER=$(bun clis/wingman-capability.ts nip98 \
  --url "$CAPROVER_REQUEST_URL" --method POST --body-file body.json \
  | python3 -c 'import json, sys; print(json.load(sys.stdin)["authorization"])')
curl --fail-with-body --request POST "$CAPROVER_REQUEST_URL" \
  --header "Authorization: $CAPROVER_AUTH_HEADER" \
  --header 'Content-Type: application/json' --data-binary @body.json
unset CAPROVER_AUTH_HEADER
```

For a GET, omit `--body-file` and the HTTP body. The broker may deny a URL outside
its capability; obtain the appropriately scoped capability rather than trying a
raw-key fallback. Do not reformat or change body.json between signing and sending.

## Validation

```bash
bun test src/caprover/agent-proxy src/auth/nip98-verifier.test.ts src/caprover
bun run typecheck
bun run --cwd apps/caprover-agent-proxy build
git diff --check
```

Tests use fake clients/local fake upstreams only. They cover auth denial, exact
payload binding, replay, forwarded-origin behavior, excluded routes, safe DTOs,
validation before mutation, operation metadata, history and PATCH wire semantics.
