# Kindling WApp Tower broker implementation handoff

## Goal

Implement the missing installation-scoped broker path that lets a managed
Tower-backed WApp use its own encrypted WApp identity for its own Tower app
database namespace without exporting `WAPP_NSEC` to the child process.

This is required to run Kindling API as the common company/enrichment service
for several Wingman/Autopilot consumers. Pete's request is tracked on Flight
Deck as `Make Kindling a shared collaborative service` and originated from
message `609f6d33-5618-4d3a-895f-352336dc0374` in workspace
`2e5caefd-dd65-45d2-b747-ee874e8e5fc9`.

## Pre-change architecture

The latest Wingman Suite Architecture board is v4. It shows multiple
Autopilots running agents/apps/workflows through Tower's NIP-98 mediated
backend, with Tower owning shared Postgres. This broker belongs in Autopilot;
Tower remains the authorization and data boundary.

## Confirmed current state

- Current repo: `/Users/mini/code/wm/autopilot`, branch `main`.
- `src/wapps/runtime-env.ts` intentionally refuses to inject raw `WAPP_NSEC`
  for Tower-backed WApps and currently throws because the replacement generic
  data broker does not exist.
- `WappSigningBroker` and encrypted app-key custody already exist.
- `WappPublishingClient` proves the key may be unwrapped only inside Autopilot
  for an exact, body-bound NIP-98 request.
- The existing `/api/wapps/:installation/activity` path is limited to WApp
  activity publishing; it is not a generic app DB path.
- Kindling API currently needs these own-namespace Tower routes:
  - `/api/v4/workspaces/:owner/apps/:appNpub/db/provision`
  - `/db/migrations`
  - `/db/tables/:table/query`
  - `/db/tables/:table/rows`
  - `/db/tables/:table/rows/:id`
- The registered KindlingAPI app is blocked with
  `raw-signing-secret-removed-use-capability-broker`.

## Required design

Add a narrowly scoped local broker capability for managed WApp child
processes. The child must receive no private signing material.

The capability should:

1. be generated for a specific managed app start and bound to the WApp
   installation/app id;
2. be provided only to that child process, not persisted in app registry JSON,
   SQLite, logs, argv, API responses, or Flight Deck;
3. be accepted only on a loopback/local Autopilot broker route;
4. resolve the WApp's configured Tower binding and encrypted app identity;
5. construct the target URL itself so the child cannot choose another origin,
   workspace owner, app npub, or namespace;
6. allow only the required own-app DB suffixes and methods, with bounded body
   size and exact serialized-body NIP-98 payload hashing;
7. proxy the response status/body/content type without revealing the signed
   Authorization event to the child;
8. fail closed on stopped/restarted app tokens, identity drift, missing Tower
   binding, disallowed paths/methods, or non-loopback callers;
9. preserve the existing WApp activity broker and publisher rotation behavior;
10. expose non-secret runtime metadata such as broker URL, installation id,
    app npub, Tower URL/workspace owner, and workspace id.

Prefer a new focused module/route rather than growing `src/server.ts`.

## Runtime/API contract

Choose clear names, document them, and keep the client contract small. A
reasonable shape is a loopback POST carrying `{ method, path, body? }`, where
`path` is a suffix under the bound WApp's own `/db` route. The worker may refine
this based on existing request-auth/process-manager patterns.

The endpoint must not become a general-purpose NIP-98 signer or arbitrary HTTP
proxy.

## App lifecycle integration

- Tower-backed WApps must start successfully once the broker capability is
  available.
- Non-Tower WApps must retain their current behavior.
- App stop/restart must revoke the old process capability.
- Existing lifecycle review state is operator/app-record state; provide a
  supported API/CLI path or clear documented operation for re-discovering safe
  scripts and clearing only the obsolete signing-secret review reason.
- Do not restart the running Autopilot server from this worker.

## Validation

Add focused tests covering:

- no `WAPP_NSEC` or raw signing secret in environment or serialized state;
- correct runtime broker metadata/capability injection;
- allowed GET/POST/PATCH/DELETE own-DB requests;
- exact body handling and NIP-98 construction through encrypted custody;
- denied arbitrary origins, workspaces, app identities, non-DB paths, invalid
  methods, oversize bodies, wrong/expired/revoked tokens, and non-loopback
  access;
- token revocation on stop/restart;
- existing WApp publishing tests remain green;
- app process launch no longer throws the current missing-broker error.

## Legacy Kindling identity migration follow-up

The broker implementation is complete, but the live KindlingAPI app still has
no local WApp assignment. Its existing Tower namespace contains 6,832 reviewed
companies under public app identity
`npub1x3khwkg426qrrlc25ekzg8k3l8y9hyut6fcxqkxpkm4d0ds45sdsqayt83`.
Creating a fresh WApp identity would create an empty second namespace and is
not acceptable.

Add a narrowly scoped, operator-invoked legacy-custody migration command. It
must accept an exact app id, exact source env file, expected public npub,
installation metadata, and Tower binding id; read only the named `WAPP_NSEC`
entry inside the process; verify that it derives the expected public npub;
store it through `WappStore` encrypted custody; and never print, return, log,
persist in argv, or place the secret in a generated command/body. It should be
dry-run by default and require `--apply` for writes. On apply it must:

- refuse an existing conflicting WApp assignment or identity;
- create or verify the KindlingAPI WApp assignment against the existing Pete
  Tower binding `be7f5e54-becc-4283-aba6-d88d56e9f6ec`;
- preserve the app id `64765f89-035a-4832-acba-b633068ba2e0` and existing
  public app npub above;
- use Pete workspace owner
  `npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy`, scope
  `bbfd13f9-1cdf-4f56-8213-cf0cffbe4d3c`, and allow Pete, Rick, and Andy
  (`npub1qkntvygrrxkc3ynfzw56aq8far9wnxcfjd8d4lfwhnnlnctn4k5sa2d05s`);
- verify encrypted custody can sign/derive the same public identity before any
  plaintext cleanup;
- atomically remove only the `WAPP_NSEC` assignment from the exact source env
  after successful custody verification, leaving every other line intact and
  setting the rewritten env file to owner-only mode (`0600`); the current
  KindlingAPI `.env` is `0644`, so the apply path must correct that exposure;
- clear only the obsolete broker review reason after safe script discovery;
- leave `autoStart` unchanged unless a separate explicit flag is supplied;
- support idempotent re-run without rotating the identity or losing the
  existing assignment.

The migration command is a one-time custody bridge, not a general secret
viewer or arbitrary WApp database editor. Add focused tests using temporary
files/databases and synthetic keys only. Do not inspect or print the real key
while implementing or testing. Do not execute the real migration, restart
Autopilot, start KindlingAPI, push, or deploy from the worker; Rick will review
and perform those operations.

Also correct the discovered `appctl --owner` route mapping for WApp Tower
binding commands. The active Pete→Rick delegation already includes
`wapps:read`, `wapps:install`, and `wapps:assign`, and direct
`/api/owners/:owner/wapps` requests succeed, but `tower-bindings`,
`tower-binding-create`, and `tower-binding-default` currently ignore
`--owner` and call `/api/wapps/...`, producing the misleading
`admin-or-execution-delegation-required` response. Route these commands through
the existing owner-space prefix when `--owner` is present and add CLI-focused
tests if practical. Do not weaken the server authorization rule.

The Kindling FE CapRover release also needs durable runtime configuration
through the delegated app-card route. Extend
`POST /api/apps/:id/deploy-to-caprover` (and therefore its owner-space rewrite)
with optional, validated `hasPersistentData`, `instanceCount`,
`containerHttpPort`, `envVars`, and `volumes` inputs, using the existing
CapRover client types/validators. When creating a remote app, pass
`hasPersistentData`; apply the requested configuration before the tar deploy.
Keep all fields optional so existing callers are unchanged. Add route tests
covering one persistent instance, port 80, `/data` volume, runtime API/owner
allowlist env, and rejection of malformed config. This avoids bypassing the
app registry with a direct CapRover admin call and lets Rick deploy Kindling FE
through the already-authorized `deployments:manage` owner route.

Manager review also found a duplicated unreachable `throw` in the broker's
Tower fetch catch block. Remove the duplicate while preserving the tested
error contract.

Run the narrowest focused tests plus `bun run check` if available and a broader
relevant test suite.

## Git and reporting

- Work on a feature branch from current `main`, suggested
  `feat/wapp-tower-request-broker`.
- Preserve concurrent work. Do not reset, rebase, discard, or overwrite it.
- Commit all tested nonignored state relevant to this work with a Conventional
  Commit.
- Do not push or restart Autopilot; Rick will integrate, push, and arrange the
  required operator restart after review.
- Report commit, files, tests, exact runtime contract, migration/compatibility
  notes, and any blocker through the supervised callback.
