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

When the HTTP installation registry is unavailable, the trusted local CLI can
bootstrap a local-only binding without the legacy scope resolver:

```sh
bun clis/wapp-pipeline-installation.ts ensure /absolute/private/installation.json
```

Its exact fields are `appId`, `ownerNpub`, `scopeId`, `launchUrl`,
`sourceWingmanUrl`, `title`. It validates the managed registry owner/root, HTTPS
origins and immutable existing binding. It creates a fresh publisher only when
absent and outputs public identity metadata. It asserts no Tower membership or
publication grant; those remain independently authorized. This local management
command does not activate server code or grant broad execution.

## Prepared scoped conversation deletion (requires platform activation)

`session.deleteConversation` executes only inside the authenticated pipeline runner.
It accepts `conversationKey`, `projectId`, exact `directory`, stable `requestId` and
`confirmation: "delete_native_transcript"`. The runner supplies the principal;
callers cannot supply an owner, session ID, transcript path or home directory.
Use an installation-pinned preparation function and separately pinned managed grant
before exposing this function to a WApp. General session-management authority is
not required or granted.

The store resolves the owned dedicated completed-turn binding, refuses pending or
uncertain turns, and persists a tombstone before runtime side effects. New turns
on that key are fenced; use a new app generation for replacement. Matching retries
share one receipt, concurrent requests share one operation, and old turn receipts
remain audit evidence. Failures after deletion begins stay fenced and require
reconciling that exact operation, never recreating the native session.

The runtime validates owner, Codex SDK role, binding ID, working directory and native
reference, and rejects any foreign live/stored/archived association with that native
ID. It stops matching runtime sessions, removes the exact matching native JSONL
transcript after checking its real filesystem boundary, and removes runtime,
message-store and archive records. It returns component-specific evidence:
`runtimeStorageDeleted`, `nativeTranscriptDeleted`, `nativeStorageDeleted:false`,
`metadataIndexesPreserved:true`. Provider metadata/index storage and pipeline audit
receipts remain; this is not full provider-history erasure. A WApp must display the
actual components deleted and preserve its own project messages intentionally.

Source preparation is not activation. The operator must separately approve the
normal managed Autopilot restart, verify the new function in the live catalog,
install a narrowly pinned deletion pipeline/grant, wire its signed receipts into
the WApp lifecycle mapping, and test only a newly created disposable owned builder.
Do not substitute existing broad stop/storage APIs or export owner keys.
