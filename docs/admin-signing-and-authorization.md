# Admin signing and authorization

An explicitly appointed human or agent Admin administers the Autopilot instance
as its own authenticated identity. Creator, identity custodian, session owner,
resource owner and linked human do not confer admin authority. The durable Users
role and configured bootstrap admins remain the role sources; effective bot
activation checks still apply. Resource ownership and existing execution identities
are preserved when another admin manages them.

The server and signing broker check the live role independently. Promoting an
already running ordinary session enables admin signing without replacing its
capability; demotion removes that added authority. A request signed before demotion
cannot preserve admin API access. Ordinary owner-local authority and explicit
nonadmin delegation remain separate from admin authority.

## Session broker operation inventory

The broker requires an opaque, active, unexpired capability bound to the calling
session and stable identity, a fresh request nonce and its operation envelope.
Admin does not impersonate another identity or bypass these transport safeguards.

| Operation / endpoint suffix under `/api/mcp/capabilities` | Admin behavior and remaining constraints |
| --- | --- |
| `identity.read` / `identity` | Read the capability's own public identity. |
| `capability.refresh` / `refresh` | Renew the same active session/identity, including the explicit expired-token renewal path; no role or target escalation. |
| `reissue-adopt` | Adopt only an explicit administrator-issued replacement for the same session. |
| `nip98.sign` / `nip98` | Ordinary admins gain supported Autopilot administrative families at the configured origin. External targets retain their capability constraints. |
| `nostr.sign` / `nostr-event` | Ordinary admins gain self-signing beyond the standard kind list, within valid integer kinds 0–65535 and existing content/tag limits. Per-kind rules still apply. |
| `nip44.encrypt` / `nip44/encrypt` | Encrypt as self. Ordinary sessions already allow all peers; explicit peer/size limits remain. |
| `nip44.decrypt` / `nip44/decrypt` | Decrypt as self. Cannot decrypt another identity's messages; peer/size and ciphertext validation remain. |
| `blossom.authorize` / `blossom/authorize` | Self-sign the dedicated object authorization after configured server, method, object hash and size checks; short expiry remains. |
| `wallet.read`, `wallet.spend` / `wallet` | Explicit wallet methods, verified amounts, cumulative budgets and reservation semantics remain separate spending authority. |
| `wapp-login` | Dedicated native login challenge validation, caller binding and exact destination signing; no admin bypass of another app's login authority. Uses the NIP-98 operation envelope. |
| `git-discovery`, `git-credential` | Session/workspace-bound discovery and credential exchange through configured native Forgejo adapters, with exact challenge signing. External repository permissions remain authoritative. Uses the NIP-98 operation envelope. |
| `secrets` | Explicit imported-secret grants and current session/profile/workspace binding; Admin does not grant custody or secret access. Uses the identity-read envelope. |
| `git-bootstrap`, former `/api/mcp/bot-crypto/*` | Retired (410), never revived by Admin. |
| `status` | Public broker service metadata; not signing authority. |

Admin expansion recognizes the standard-agent/full-Nostr operational baseline.
`none`, deliberately custom or narrow capabilities, operation removals and explicit
body-hash restrictions are not widened. Full-agent retains its explicit arbitrary
NIP-98 destination policy; it does not acquire a different identity or bypass
reserved-kind validators. Admin does not convert ordinary sessions to full-agent.

Generic event signing cannot mint NIP-98 (27235), Blossom authorization (24242) or
key-custody transfer (445) events. Use the dedicated protocol. Flight Deck instruction
kind 33358 requires its protocol tag, exact content hash and unambiguous workspace
and channel tags. Tower still verifies that instruction and the exact NIP-98 request
body against its own ACLs. These checks apply even to broad event-signing modes.

## Autopilot API inventory

`admin-signing-policy.ts` defines the supported administrative family boundary;
`admin-signing-targets.ts` produces a request-specific exact target at the configured
Autopilot origin. Families are:

- `admin`, `agent-chat`, `apps`, `archive`, `artifacts`, `auth`, `billing`, `caprover`,
  `chats`, `cloudflare`, `config`, `control-plane`, `delegations`, `delegate-sessions`;
- `directories`, `docs`, `feature-flags`, `git`, `gitea`, `identity`,
  `instance-settings`, `logs`, `maple`, `ngit`, `nightwatch`, `npub-projects`, `owners`;
- `pipelines`, `projects`, `remote-instruct`, `scheduler`, `session-dispatches`,
  `sessions`, `skills`, `system`, `terminal`, `todos`, `uploads`, `user`, `wapps`,
  `workspace`.

Signing a family is authentication, not a promise that every suffix or method is a
route. Each handler retains input validation, supported methods, availability,
resource boundaries and operation-specific checks.

| API surface | Authority / resource semantics |
| --- | --- |
| Apps and WApps | Actual admin can manage cross-owner resources. `/api/owners/<owner>/apps` and `/wapps` select that owner's resources; creation preserves that owner. WApp Tower registration/publication still needs external installation authority. |
| Sessions and archives | Actual admin can read/manage across owners. Owner routes retain the named owner's selection and preserve actor attribution. Exact-session capability queue restrictions remain even for admins. |
| Pipelines | Actual admin can read/manage private runs across owners. `/api/owners/<owner>/pipelines/*` selects that owner's runs and user definitions; new owner-pipeline access is admin-only. Existing nonadmin pipeline access is unchanged. Built-in/shared definitions retain API editing restrictions and versioned source workflows. |
| Schedules and file triggers | Admin can list/edit/delete/trigger across owners; owner routes select one owner. Editing preserves the job owner and historical run identity; selecting a replacement run identity still requires valid owner custody. Retired Nostr triggers remain unsupported. |
| Control-plane discovery, pipeline viewer, live-thread activity | Actual admin passes owner authorization; explicit context, endpoint readiness and run/viewer binding checks remain. |
| Users, signing policies, settings, flags, billing, terminal, infrastructure | The same actual-principal admin checks apply to browser and verified NIP-98 requests. Terminal PIN/tickets and external provider/deployment credentials remain required. |
| Files, directories, projects, skills, todos, chat | NIP-98 is resolved before normal dispatch; admin admission does not remove filesystem, owner-specific storage or product validation boundaries. |
| Auth/profile, uploads, logs, artifacts, configuration | Resolve the actual caller before dispatch. Login proofs, file ownership, upload/storage validation and supported public reads remain their normal protocols. |

## Binding and revocation

NIP-98 binds the exact URL including query, uppercase method and every body byte.
A body-bearing request needs its matching payload tag; a bodyless request needs no
payload tag, including DELETE and POST. Live admin targets admit bodyless methods;
the real verifier rejects a missing or mismatched payload for any nonempty body.
Narrow exact policies keep their stronger body requirements.

A fresh nonce makes independently signed identical requests distinct even within
one second. Each exact signed event is accepted only once, within the verifier's
freshness/skew window. A dispatch resolves authentication once and shares the
verified context through its handlers; this is not a reusable proof cache.
Invalid explicit NIP-98 never falls back to a privileged browser cookie.

## Independent authority and explicit exceptions

- Autopilot Admin grants no Tower/NStack workspace, scope, repository, app,
  installation or storage ACL. Unrelated origins remain denied by ordinary broker
  policy. External Blossom destinations remain explicitly configured.
- `/api/internal/*`, `/api/mcp/*` and Unix signer sockets keep opaque grants,
  actual loopback/OS controls and dedicated operation protocols. NIP-98 alone is
  not a replacement credential. Supervised dispatch remains loopback/caller-session
  bound; pipeline callbacks retain their callback token.
- Application signer `get_public_key`, `sign_event`, `nip44_encrypt` and
  `nip44_decrypt` use durable application grants, exact key identity, method,
  peer and per-kind constraints. Hosted-site user proof/installation attestation,
  browser-signing grants, WApp publisher custody and imported-secret operations
  remain separate. Admin is not a grant to sign as those identities.
- Secret inventory/grant custody, bot-key replacement/export, browser NIP-07 or
  bunker signing and recovery retain explicit custody/confirmation protocols.
  Broker sessions cannot administer secret custody merely because they are admins.
- Existing no-signing/project-tool-only/custom capabilities remain restricted.
  Wallet budgets and explicit delegated spending are never inferred from Admin.
- Admin does not invent a missing workspace, thread, installation, runtime identity,
  external credential or transport. Missing state and external denials remain visible.

## Migration from implicit custodian access

Verified NIP-98 always starts in the signer's self-space. The linked custodian is
stored only as `advisoryOwnerNpub`; it never populates `delegatedOwnerNpub`, grants
an admin role or selects the custodian's records. This applies to nonadmins too.
A caller that previously relied on the legacy implicit mapping must use an actual
active scoped grant and `/api/owners/<owner>/…`:

- Sessions/archive: use `/api/owners/<owner>/sessions` or `/archive`; the sessions
  CLI exposes owner selection and builds these routes. Replace legacy
  `/api/delegate-sessions` flows with explicit owner routes.
- Scheduled jobs, apps and WApps: use the corresponding owner-prefixed scheduler,
  apps or WApps routes with their required scopes/resource filters. An appointed
  admin may instead use ordinary cross-owner administration.
- Agent Direct and scheduler engines retain their trusted stored owner, stable
  bot and installation/session bindings. Removing HTTP advisory authority does not
  rewrite those records or change execution identity. External Tower calls still
  require their own workspace/app permissions.

After demotion, a bot cannot fall back to its custodian's authority. Its real
self-space, exact-session lifecycle/queue capabilities and actual scoped grants
continue under their normal rules. No missing delegation is fabricated for legacy
compatibility; failures identify the grant/routing migration that is required.

## Validation and activation

Run the signing/auth and route composition tests from a disposable source copy,
with disposable data and fixture configuration. Some legacy tests use source-relative
hardcoded data paths, so changing only the working directory or database environment
is insufficient. Never run broad suites against a managed instance's live data.

The composition fixture uses the real broker, real NIP-98 verifier and central API
dispatch with disposable scheduler/pipeline/WApp stores. It covers live role changes,
cross-owner resources, stable identity, body/no-body methods, tampering, replay,
reserved protocols and negative controls. External services and process operations
are fixtures; source validation is not deployment verification. Activate reviewed
source only through the authorized operator, preserving identity, storage and config,
then verify actual admin and nonadmin journeys on the selected instance.
