# Agent capability broker

Autopilot agent sessions use a stable per-owner bot identity without receiving
its private key. The implementation boundary lives under `src/signing/` and is
currently hosted inside the Autopilot control process. Its API and key resolver
are isolated for later daemon extraction, but this release does **not** claim
OS-process separation.

## Trust and identity model

- **Stable agent identity**: the active bot-key record owned by the session's
  authenticated user. Ordinary agent signing, NIP-44, and Blossom operations
  use this identity.
- **Wingman instance identity**: the control-plane identity configured by
  `WINGMAN_PRIV`. Agents receive only its public npub. It is never an implicit
  fallback for agent operations. The separately scoped runner-signing API is
  the exceptional instance-signing path.
- **Human delegation**: browser-mediated Tier 2 signing with an approved grant.
  It is distinct from the agent capability and does not turn the agent into the
  human signer.
- **Wallet authority**: a separate operation family with independent read
  methods, spend methods, per-payment maximum, and cumulative budget. General
  Nostr signing does not grant wallet access.

The broker holds opaque token hashes, not reusable plaintext tokens. Each
capability binds an ID, issue/expiry time, exact live session, session owner,
stable bot npub/pubkey, allowed operations, operation constraints, replay
nonces, rate state, revocation state, and wallet spend accounting. It rejects a
stopped/error session, owner change, bot-key rotation, expired/revoked token,
reused nonce, missing operation, or widened request.

Stable agent private keys are held in the local encrypted vault implemented by
`src/signing/broker-key-vault.ts`. It uses a random AES-256-GCM master key,
`0600` files, authenticated identity binding, atomic writes, and per-operation
plaintext copies that are zeroed after use. The vault is enabled by default for
both native Bun and Docker deployments; Docker's existing persistent `data`
volume preserves it across container restarts. A deployment may mount the
master key at another path with `WINGMAN_BROKER_MASTER_KEY_FILE`.

This is deliberately an accidental-disclosure boundary, not a claim of hostile
same-user isolation. Code running as the Autopilot OS user with broad filesystem
access can ultimately recover an agent's own key. The security gain is that the
key is no longer routinely copied into session environments, argv, MCP config,
PM2 state, logs, or prompts, and ordinary operations are scoped and audited.
the operator's human/Tier 2 key, the Wingman instance/root key, capability-minting
secrets, and wallet secrets remain separate and must never enter the agent vault
or child environment. Deployments needing protection from a malicious local
agent can later move the same vault interface behind an OS or hardware boundary;
that is optional hardening, not required for normal Autopilot operation.

## Operation matrix

| Operation | Default agent scope | Important enforcement |
| --- | --- | --- |
| Public identity | Own stable bot only | Live session, bound owner and bot record |
| NIP-98 | Configured Tower `/api/v4`, explicit local Autopilot API prefixes, and exact brokered restart/status routes | Origin-specific scheme/host/port/path/method targets; POST/PUT/PATCH require an exact body hash |
| Nostr event | Explicit named kind allowlist; the default includes common profile/social/app-release kinds plus Flight Deck PG instruction kind `33358` | Kind, broker-owned timestamp, content/tag byte limits, tag count and optional tag constraints |
| NIP-44 encrypt/decrypt | Stable bot identity; separate operations, not event kinds | Direction, valid peer pubkey, payload byte limits, and decryption errors; no instance fallback |
| Blossom authorization | Configured server origin | Method, SHA-256 object hash, object size and optional exact-hash list |
| Wallet read | No production default | Separate adapter and allowlisted methods required |
| Wallet spend | No production default | Separate operation, method, per-call and cumulative msat budgets |
| Raw key/export/arbitrary Schnorr | Never | No broker operation exists |

The default peer policy currently permits any valid NIP-44 peer because normal
encrypted messaging needs dynamic correspondents. A deployment that knows its
counterpart set should issue a narrower policy. Default payload limits bound
plaintext to 1 MiB and ciphertext to 1.5 MB before cryptographic work. The
signer identity remains strictly fixed even with the wildcard peer set.

The default Nostr event allowlist is the named
`DEFAULT_AGENT_NOSTR_EVENT_KINDS` constant. It preserves the existing profile,
note, contact, legacy encrypted-message, reaction, relay-list, app-data, and
Flight Deck instruction kinds, and adds the explicit Zapstore release set:
software asset `3063`, Blossom authorization `24242`, software release `30063`,
and app metadata `32267`. Kind `24242` is present for publishing clients that
request generic event signing, while broker-native Blossom clients should use
`blossom.authorize`, which independently enforces server origin, method, object
hash, and object size. NIP-44 encryption/decryption likewise remain dedicated
operations with their own constraints; neither Blossom nor NIP-44 widens the
event-kind allowlist. Unknown kinds remain denied.

## Agent use

MCP tools call the broker automatically. Shell workflows use the client without
placing the capability on argv:

```sh
bun clis/wingman-capability.ts identity
bun clis/wingman-capability.ts nip98 --url "$TOWER_URL/api/v4/flightdeck-pg/workspaces" --method GET
bun clis/wingman-capability.ts event --kind 1 --content "status" --tags-json '[]'
bun clis/wingman-capability.ts encrypt --peer <hex-pubkey> --text "message"
bun clis/wingman-capability.ts decrypt --peer <hex-pubkey> --ciphertext <value>
bun clis/wingman-capability.ts blossom-auth --server https://blossom.example --method upload --hash <sha256> --size <bytes>
bun clis/wingman-capability.ts blossom-upload --server https://blossom.example --file ./artifact.png --content-type image/png
bun clis/wingman-capability.ts wallet --method get_balance
```

`WINGMAN_CAPABILITY` is injected into the session environment and inherited by
the MCP subprocess. Its value is deliberately omitted from argv and generated
MCP configuration. Codex uses `env_vars`, Goose uses `env_keys`, and Claude and
OpenCode use their documented environment-reference syntax; only the variable
name/reference is serialized. Never print the value, paste it into
chat/task/docs, put it on a command line, or commit it. If policy denies an
operation, request a narrower capability through the control plane; do not
search for a private key.

The `event` output is standard Nostr JSON and can be piped to `nak verify`.
Direct `nak --sec`, `NOSTR_SECRET_KEY`, and raw-key `nak bunker` workflows are
forbidden for agents. A direct NIP-46 adapter for unmodified NAK commands is
deferred; use the broker client for event, NIP-98, NIP-44, and Blossom work.

### Native Forgejo credentials

`git-credential-wingman` version 3 uses the loopback capability routes
`POST /api/mcp/capabilities/git-discovery` and
`POST /api/mcp/capabilities/git-credential`. They bind to the live session's
managed actor identity; a Tower workspace binding is not required. Discovery
returns configured `WINGMAN_FORGEJO_SERVERS` origins without contacting Tower.
Each configured server has `origin`, `towerIssuer`, `sourceName`, `clientId`, and
`redirectUri`. Use the stock public git-credential-oauth client and registered
loopback callback. Native origins must be HTTPS. Forgejo OAuth account tokens
are not repository-scoped; native permissions apply on every request.

The broker obtains a stock Forgejo authorization-code OAuth token with S256
PKCE, exact callback state, native HTTP session cookies, and the stock consent
form. Tower's structured one-minute OIDC challenge is signed with exact URL,
method, payload hash, nonce, audience and expiration. The private key stays in
the managed signer. The broker refuses foreign redirects and cannot bypass
password, 2FA or account-linking screens. Forgejo native auto registration is
required for unattended fresh accounts. No admin PAT is used.

Native account credentials are held only in process memory, keyed by actor and
origin. The helper `store` and `erase` actions do not persist tokens. Before
reuse the broker validates the native account at `/api/v1/user`; expiry or 401
discards the credential and triggers one new sign-in. Permission denials and
network failures do not reauthenticate. The issue/PR client retries a 401 once;
403/404 are final. Tokens are never written to Git configuration, disk, logs,
command arguments, remote URLs or environment. A valid cached token requires
only Forgejo, so it continues working while Tower is unavailable.

All repository Git/API operations and permissions are native Forgejo. The old
`git-bootstrap` endpoint returns 410; there is no Tower grant, issue proxy or
repository-resolution fallback. Tower allowlist removal stops new login only;
revoke native accounts/tokens separately in Forgejo.

For Flight Deck work, use the broker-aware MCP `flightdeck_*` tools. PG chat
creates and edits require two signatures from the same stable bot identity: a
body-bound kind-`33358` instruction event in `message_signature`, followed by
the NIP-98 signature over the exact HTTP payload. The default session policy
allows both operations. NIP-98 alone is intentionally insufficient and must
not be retried as a fallback. The PG CLI
raw `--key` mode is retained only as an explicit operator path until its full
Tower client stack accepts an asynchronous broker signer.

## Lifecycle, audit, and operations

Capabilities expire after at most two hours. The long-lived MCP client refreshes
them after 90 minutes through a same-policy operation that cannot add operations or
broaden constraints. A shell CLI launched from an older, still-live session may
also renew an expired capability and retry once. Expiry continues to deny every
signing and data operation; only the refresh endpoint accepts the expired token,
and it revalidates the exact live session, owner, stable identity, policy, nonce,
rate limit, and revocation state before renewal. Capabilities are revoked by
the process manager when a session stops, errors, or is deleted. Every request
also revalidates live session and bot-key state, so archived/stale session rows
never authorize cryptography. Audit entries contain capability ID, session ID,
bot npub, operation, outcome, reason, and timestamp only. They never contain a
token, key, plaintext, ciphertext, NWC secret, request body, or wallet params.

The broker durably stores active capability verifier state in
`data/capability-broker-state.json` (override with
`WINGMAN_CAPABILITY_STATE_FILE`). The file contains one-way token hashes,
scope/policy, expiry, replay nonces, rate state, and wallet budget state—not the
bearer token or private key—and is atomically replaced with mode `0600`.
Unrevoked verifier records remain after access expiry so a live session can use
the refresh-only recovery path. Stopping, erroring, or deleting the session
revokes and removes its renewal authority. Managed Autopilot restarts stop agent
processes and issue new session capabilities to the resumed or fresh replacements.

The child environment starts from a documented base allowlist. Controlled
runtime injection may add provider, billing, git, public identity, and broker
values, but a final sanitizer removes root Nostr keys, signing secrets, NWC
credentials, and `NOSTR_SECRET_KEY` before direct Bun launch.

After deploying this code, the operator must restart Autopilot from outside the
managed session, then rotate the previously exposed Wingman instance key and
any credentials that may have entered historical agent environments. Rotation
is intentionally not performed by this implementation.

### Existing identity migration

At startup, Autopilot immediately rewraps every legacy
agent identity that the control process can unlock through old Key Teleport
escrow. The local vault is then sufficient for later restarts and Key
Teleport can be removed. If legacy
escrow is unavailable, session creation fails closed with
`broker_key_not_provisioned`; Agent Direct stores that code and the full
operator-facing diagnostic in both the durable turn and Flight Deck dispatch
outcome. The existing authenticated browser `/api/bot-keys/unlock` ceremony
also provisions the vault before retaining any compatibility in-memory key.
No instance-key fallback exists.

For an installation whose current records have only legacy escrow and whose
browser unlock route cannot decrypt them, perform one controlled migration:

1. Restore `KEYTELEPORT_PRIVKEY` to the Autopilot control process only.
2. Start the new build once and confirm the startup migration message for each
   stable identity.
3. Remove `KEYTELEPORT_PRIVKEY` and restart again. Broker signing must continue
   from the vault before the legacy credential is rotated/retired.

Never inject that migration credential into a child session.

For upgrades from a release that still injected `AGENT_NSEC`, provision the
vault **before** restarting or closing the final legacy session. The migration
must consume that agent-owned credential inside a fixed-purpose local process,
validate it against the stored stable bot pubkey, write only the encrypted vault
envelope, and wipe temporary bytes. Never paste the value into argv or logs.
Once the envelope exists, new sessions receive capabilities and the legacy
session should be closed. If neither legacy escrow nor a still-running legacy
session exists, use the authenticated browser unlock route; it now prefers the
user's stable agent record even when `WINGMAN_PRIV` is also configured.

`bun scripts/provision-broker-vault.ts` provides a secretless operator migration
for installations whose historical escrow key is still available under the
retired Key Teleport setting or matches the current instance identity. It never
prints private material and validates the stable agent identity before writing.

## Administrator-managed signing policies

Settings → Signing Policies is the administrator control plane for non-secret
policy fragments. The built-in `builtin-default-agent` baseline remains applied
to every capability and is read-only. With no enabled matching assignment, the
effective policy is byte-for-byte the existing default agent policy. Custom
fragments are sorted by stable policy ID and match profile/workspace assignments
with fail-closed semantics: when both lists are populated, both must match.
Unassigned or disabled fragments grant nothing.

Policy documents include a stable ID, name, description, enabled state,
revision, broker operations, event kinds, per-kind Nostr constraints, exact
HTTPS origins, methods, exact paths/path prefixes, payload-hash rules,
constrained challenge tags, profile/workspace assignments, timestamps, and actor attribution. Every create,
update, enable, and disable operation appends an immutable revision snapshot to
`data/signing-policies.json` (override with `WINGMAN_SIGNING_POLICY_FILE`). The
registry rejects wildcard/non-HTTPS origins, unsafe methods, root or broad API
prefixes, mutating targets without body hashes, arbitrary kind `27235` event
signing, unknown operations/tags, duplicate target/rule IDs, and challenge
windows outside 1–60 seconds.

### Custom generic Nostr kinds

An administrator can add a kind that is not compiled into
`DEFAULT_AGENT_NOSTR_EVENT_KINDS` with a `nostr.sign` policy. Every such kind
must have exactly one matching `nostrKindRules` entry. The rule explicitly
bounds UTF-8 content bytes, tag count, aggregate UTF-8 tag bytes, allowed tag
names, and optional exact required `[name, value]` pairs. Custom rules are
capped at 64 KiB of content, 64 tags, 16 KiB of aggregate tag data, and 32
allowed tag names; larger limits are rejected as unreasonably broad. Required
tag names must also appear in `allowedTagNames`, and duplicate, missing,
mismatched, or malformed rules fail validation.

For example, create a policy through the administrator API or edit an existing
custom policy in Settings with this structured JSON shape:

```json
{
  "id": "custom-release-event",
  "name": "Custom release event",
  "description": "Allows one application event with an exact release scope.",
  "enabled": true,
  "operations": ["nostr.sign"],
  "eventKinds": [31337],
  "nostrKindRules": [
    {
      "kind": 31337,
      "maxContentBytes": 4096,
      "maxTags": 8,
      "maxTagBytes": 2048,
      "allowedTagNames": ["scope", "p"],
      "requiredTags": [["scope", "release"]]
    }
  ],
  "nip98Targets": [],
  "assignments": { "profileIds": ["agent-profile-id"], "workspaceIds": [] }
}
```

Review the normalized limits and exact required pairs in the Settings summary,
save the new revision, then enable and assign it. The revision affects only new
capabilities. Existing sessions remain on their issued snapshots and appear
stale; use **Revoke and reissue** only when that session should adopt the new
authority. Normal capability refresh never adopts it.

Generic `nostr.sign` rejects kind `27235` in the registry and again at the
broker boundary, even if a malformed capability snapshot names it. Kind
`27235` remains available only through an exact, body-bound `nip98.sign`
target such as the Tower Forgejo template. A custom kind with no unique rule is
also denied at the broker, so bypassing registry validation cannot turn a bare
kind number into signing authority. The built-in kind list and its existing
global limits remain unchanged.

Each issued capability records both the fully merged policy snapshot and the
effective policy ID/revision list. Editing a policy never mutates that snapshot.
The Settings page compares issued references with current assignment resolution
and labels active capabilities `current` or `stale`. Normal
`capability.refresh` only extends the exact old snapshot. The deliberate
reissue action first revokes all old session capabilities and then resolves and
issues current revisions using the session's bound owner, profile, workspace,
and bot identity. On success, the already-running local broker client uses a
one-time, explicit `reissue-adopt` handoff on its next call; this is separate
from same-policy refresh. On issuance failure the old bearer stays revoked and
the operator must restart that session to recover. Neither the API nor UI
returns the replacement bearer.

Administrator-only API routes are:

- `GET/POST /api/admin/signing-policies`
- `GET/PUT /api/admin/signing-policies/:id`
- `POST /api/admin/signing-policies/:id/enabled`
- `GET /api/admin/signing-policies/:id/history`
- `GET /api/admin/signing-policies/:id/sessions`
- `POST /api/admin/signing-policies/sessions/:sessionId/reissue`

Authentication and administrator authorization run before any policy or active
session inventory is read.

### Tower Forgejo Login template

`tower-forgejo-login` ships disabled and unassigned. Configure its one exact
HTTPS completion origin/path in Settings, assign profile IDs and optionally
workspace IDs, then enable it. Set `TOWER_GIT_OIDC_COMPLETION_URL` before the
first policy-store creation to seed a nonstandard Tower issuer path; otherwise
the seed is `/api/v4/git/oidc/authorize/complete` on the configured HTTPS Tower
origin, or the visibly inert `tower.example.invalid` placeholder when
Autopilot only knows an internal HTTP Tower URL.

This template produces kind `27235` only through `nip98.sign`. It requires
`POST`, the exact completion path, and the SHA-256 hash of the exact
`JSON.stringify({request_id: nonce})` bytes. The caller must provide exactly
one bounded `nonce`, `aud`, and integer `expiration`; expiration must be after
broker time and no more than 60 seconds ahead (or the administrator's narrower
configured value). Canonical `u`, `method`, and `payload` tags are broker-owned.
The returned event contains only the six Tower contract tags, so the usual
private session-binding tag is intentionally omitted. Capability ID/session
binding and allow/deny audit remain internal. Replay of the same challenge is
denied even with a fresh broker request nonce.

Agents can request the proof without a raw-key fallback:

```sh
body_file="$(mktemp)"
printf '%s' '{"request_id":"<opaque-request-id>"}' > "$body_file"
bun clis/wingman-capability.ts nip98 \
  --url 'https://tower.example/api/v4/git/oidc/authorize/complete' \
  --method POST \
  --body-file "$body_file" \
  --tags-json '[["nonce","<opaque-request-id>"],["aud","<client-id>"],["expiration","<unix-seconds>"]]'
```

Use a disposable file with exact bytes and remove it after the test. Test first
with a deliberately wrong path or expiration and confirm denial, then with a
fresh Tower challenge. Successful signing proves only that Autopilot issued a
constrained proof. It does **not** grant Tower or Forgejo membership: Tower
still validates the proof, consumes the one-minute challenge, and independently
decides whether the Nostr identity is allowed to sign in. Forgejo alone decides repository access.

Source changes and initial policy-store creation require an external Autopilot
restart. Later policy edits persist and affect new or explicitly reissued
capabilities immediately; they do not require a restart and never widen active
capabilities silently.

## Execution-bound WApp native reader login

`POST /api/mcp/capabilities/wapp-login` accepts the ordinary broker bearer and
fresh capability nonce, with JSON `{sessionId, wappInstallationId, url}`. The
URL must be the exact HTTPS `<registered-origin>/api/auth/login`, without query,
fragment or credentials. This route uses the existing `nostr.sign` operation
but has its own mandatory native-login constraint; it does not add kind 27235
to generic event signing or expand NIP-98 origins.

The live session must be scheduler-originated and bound to the same installation
both in its metadata and in the current trigger. The installation must be active,
owned by the session owner, in that owner's workspace, and explicitly register
the requested origin. These checks run again after fetching the challenge, so
removing the execution binding revokes access immediately. Existing session
capabilities use the live binding without requiring reissue once the host loads
this implementation.

The broker obtains `GET /api/auth/challenge` from that exact origin itself, with
redirects disabled, a ten-second timeout and a 16 KiB response limit. Supported
native templates contain exactly `kind:27235`, a bounded slug ending in `-login`,
a timestamp within 60 seconds, and one UUIDv4 `challenge` tag. Caller-supplied
events and tags are never used. Duplicate challenges are denied per capability.
The result is `{event, signedBy, wappInstallationId, url}`; the stable session bot
signs, never the owner or installed publisher. The client sends `{event}` to the
exact login URL and uses the resulting app session for reads. The WApp remains
responsible for validating its login challenge and reader authorization.

This is a native event login, not NIP-98 over the login JSON: placing the signed
event inside `{event}` cannot produce a non-circular payload hash. Do not obtain
a Tower-targeted signature and replay it against a WApp login route.

Source validation: `bun test src/signing/wapp-login.test.ts
src/signing/capability-broker.test.ts src/auth/wapp-activity-authority.test.ts`
and `bun run typecheck`. Loading this new route requires the managed host to
reload source; no host restart is performed by the implementation or client.

## Deliberately deferred

- Optional isolation of the vault behind a separate OS account, service, remote
  signer, or hardware boundary. The current local vault makes no claim against
  a malicious same-user agent recovering its own identity key.
- A direct local NIP-46/bunker adapter for unmodified NAK commands.
- Production NWC/wallet adapter wiring. The policy and fake-only budget tests
  exist, but production wallet reads and spends fail closed (`501`) today.
- Migrating the operator-oriented Flight Deck PG client stack from synchronous
  local key signing to the asynchronous broker signer.

These omissions do not restore any agent key-export or shared-instance fallback
path. They limit which workflows are available through the broker.

## Local workspace-agent inventory

The 2026-08-03 inventory found 319 raw-key-referencing files under
`/srv/workspace/mycode`: 283 task-specific one-off scripts, four
historical heartbeat scripts, and 32 other historical migration/graph/Flight
Deck/signing helpers after excluding the maintained `lib/yoke.js` boundary.
They are classified as inert evidence in `mycode/RAW_KEY_ARCHIVE.md`, not
approved runtime paths. Maintained guidance and the shared Yoke helper now fail
closed for agent raw-key resolution; the Signal daemon and two reusable legacy
dispatch/repair helpers are retired until they have dedicated broker-aware
authority. A plaintext historical 64-hex fallback was removed. The archived
files were not bulk-rewritten because doing so would alter historical evidence.
