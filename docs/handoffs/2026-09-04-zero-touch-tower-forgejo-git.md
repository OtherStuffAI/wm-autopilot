# Zero-touch Tower-backed Forgejo Git for Autopilot agents

## Outcome

Autopilot sessions should be able to use normal `git clone`, `fetch`, and authorized `push` operations against any Tower-advertised Forgejo gateway without Pete configuring provider credentials. Workspace membership and Tower repository grants determine access.

Origin: @[Message](mention:message:d604265b-9066-4261-bcc7-cb9a1649a678) and @[Enable zero-touch Tower Forgejo Git for Autopilot agents](mention:task:bd89e96c-efd6-4a64-b02a-7bf49bf0c50b).

Architecture reference: Wingman Suite Architecture v4 at `https://pale-log-tank.rick.runwingman.com/artifacts/Wingman_Suite/wingman-suite-arch/v4/`. Tower owns authority; Autopilot owns session execution and local capability brokerage.

## Non-negotiable constraints

- No Tower, Forgejo, organization, or repository hostname/namespace may be hardcoded.
- Resolve origins from the active Tower workspace connection/service-discovery contract or explicit operator configuration.
- Use only the current session's loopback capability broker and stable agent identity. Never search for or export a private key.
- Never persist or log the returned short-lived Git capability.
- Git configuration must be scoped to the discovered gateway host and repository path with `credential.useHttpPath=true`.
- Work on `main`, preserve concurrent changes, commit all nonignored tested state, and do not push or update `deployed`.
- Do not restart the running managed Autopilot process. Pete authorized rebuilding the local Tower/Forgejo Docker stack for integration testing.

## Helper behavior

Implement a real executable named `git-credential-wingman` using Git's credential-helper protocol:

- `get`: read `protocol`, `host`, `path`, and other standard fields from stdin; reject non-HTTPS, unknown/unadvertised gateways, malformed paths, and paths that do not resolve to a Tower repository; call a loopback-only Autopilot broker route; output a fixed non-secret username plus the ephemeral capability password.
- `store`: do not persist the credential; success/no-op is acceptable if Git requires it.
- `erase`: evict any bounded in-memory cache entry if caching is used.
- Never include credential material in normal logs, errors, telemetry, task comments, command arguments, or environment variables.

The helper should be small and independently testable. Prefer a compiled executable or a stable launcher whose runtime is guaranteed in the image.

## Dynamic discovery and session wiring

Derive the Tower API and public Git gateway from the current workspace connection and Tower service metadata. If required metadata is not yet exposed, surface the missing contract and coordinate the minimal Tower addition; do not introduce a hostname fallback.

When a session is created or its workspace binding changes:

1. determine all Tower-advertised Git gateway origins available to that session;
2. install host-specific `credential.<gateway>.helper=wingman` configuration;
3. install `credential.<gateway>.useHttpPath=true`;
4. provide the helper only the loopback broker/session context it requires;
5. remove or supersede stale host configuration when the binding changes.

Do not configure the helper globally for arbitrary HTTPS hosts.

## Broker boundary

Add a narrowly scoped loopback broker operation that:

- binds the request to the current session and agent profile;
- verifies the requested host is one advertised by the active Tower connection;
- parses and canonicalizes `/<organization>/<repository>.git`;
- resolves that path to the stable Tower repository/workspace identity;
- produces a payload-hashed NIP-98 request to Tower's credential exchange using the session agent signer;
- returns only the ephemeral credential and expiry to the local helper.

The Tower worker is changing the exchange so the helper does not need to infer `upload-pack` versus `receive-pack`; Git's helper input does not provide that service. The gateway will validate the actual Git service and required scope at request time.

## Docker packaging

Install the executable at:

```text
/usr/local/bin/git-credential-wingman
```

Make the Docker build fail if it is missing or non-executable. Update setup/readiness/operator documentation so a fresh Autopilot installation receives the helper without manual intervention.

## Tests

Add focused tests for:

- Git credential input parsing and output formatting;
- dynamic discovery and rejection of hardcoded/unadvertised hosts;
- path canonicalization and per-repository isolation;
- loopback/session binding and NIP-98 exchange body;
- no-op store and cache-clearing erase;
- expiration/renewal and redaction;
- session Git configuration and removal of stale config;
- Docker/build installation.

Integrate against the rebuilt local Tower + gateway + Forgejo stack and prove authorized clone/fetch, authorized work-branch push, protected-branch denial, and foreign-repository denial.

## Handoff

Report changed files, test/build commands and results, integration evidence, commit SHA, and any remaining managed-runtime acceptance step on the Flight Deck task. Leave the task in progress for the manager's cross-repository review.

## Manager cross-contract correction

The active stack-bearing Tower API does not expose
`/repositories/resolve`. Its authenticated
`GET /api/v4/git/workspaces/:workspaceId/repositories` response already lists
only actor-visible repositories and includes each canonical `git_path`.
`TowerGitCredentialBroker` must use that existing route and exact-match the
helper's canonical request path against `repository.git_path`, while validating
the returned workspace and repository identifiers. Remove the speculative
resolver call and update its tests/documentation before final acceptance.
