# Managed WApp pipeline execution

The loopback-only `POST /api/internal/wapps/pipelines` broker separates a managed
installation's narrowly authorized execution from its publisher signing custody.
It accepts an opaque server credential and a validated HTTP request, never an
arbitrary event or supplied hash. It denies browser Origin headers and nonlocal
peers. No Flight Deck dispatch or custom workshop route participates in execution.

Register using the trusted local CLI:

```sh
bun clis/wapp-pipeline-grant.ts register /absolute/private/registration.json
```

Registration has exactly `ownerNpub`, `installationId`, `appId`, `definitionId`,
`origin`, `callbackUrl` and `expiresAt` (Unix milliseconds, at most 90 days ahead).
The installation must be active and owned by the managed app owner. A missing
publisher identity is freshly created inside broker custody; existing identities
without broker custody are denied. No human/agent key is exported or reused.
Registration pins the actual app root, publisher, definition and user-function
hashes. It validates a public HTTPS callback on the installation launch origin.
The CLI emits only public metadata and the path of a private 0600 opaque capability
file. The runtime reads that file on the server; never send its contents to browsers.

The broker request body has `method`, `path` and optional `serializedBody`.
The sole POST route is `/api/pipelines/definitions/{encodedDefinitionId}/runs`.
Its exact serialized JSON must contain webhook mode, immutable `idempotencyKey`,
`input`, and `webhook: {url: configuredCallback}`. Inputs cannot override definition
defaults. GET permits trusted webhook signer discovery and only runs/deliveries
previously accepted by that installation grant. Definition drift, expiry,
revocation, publisher/app/owner/root drift and foreign runs are denied.

Each request receives fresh app-signed NIP-98 authorization for the exact URL,
method and transmitted bytes. Runs are owned by the app identity. A narrow internal
execution path bypasses broad session management only after validating this grant;
it is unavailable to ordinary public callers. Responses contain the original
pipeline response, HTTP status and a public signed request receipt. Acceptance,
polling and delivery ACK never establish business completion. WApps must persist
request/run mapping and apply authoritative signed callbacks transactionally.

## Typed service custody

`secrets.typesafeNoul` performs one fixed TypeSafe HTTPS call with typed Noul
questions. It cannot accept an arbitrary URL, header or raw credential. Its inputs
are `credentialRef`, `model`, `state` and `questions`. The imported secret must be
explicitly authorized for the app principal and selected definition; export can
remain disabled. The granting owner may own the credential while the app remains
the run principal. That owner binding is supplied only by the trusted broker.
Only validated finite probabilities and model identity escape the adapter. Errors
are typed retryable classifier errors. Policy is rechecked after inference;
revocation cannot be undone by updating stale usage metadata.

## Concrete activation contract

These source modules require the normal reviewed platform build/activation. A
worker must not restart the running Autopilot to activate them. Validate with:

```sh
bun test ./src/secrets/typesafe-noul-service.test.ts ./src/wapps/pipeline-request-broker.test.ts ./src/wapps/wapp-publishing-client.test.ts ./src/secrets/secret-runtime.test.ts ./src/pipelines/public-call-api.test.ts
bun run typecheck
```

After operator-approved platform activation, register the real installation and
configure its server with broker loopback URL, opaque credential file path,
Autopilot HTTPS origin, pinned definition, app public key, callback URL and pinned
Autopilot webhook signer. Supply a newly authorized TypeSafe imported service
reference; keep its value exclusively in imported secret custody. Update the app
owned definition through the supported manual-edit API, then register a fresh grant
for the resulting exact definition/function hashes. Historical grants fail closed
on drift. Keep builder generation gated until the dedicated isolated completed-turn
runtime has independent native execution and denial evidence. Capture real signed
requests, terminal callbacks and durable duplicate/replay/forgery evidence before
claiming hosted acceptance. Source fixture tests do not supply that evidence.
