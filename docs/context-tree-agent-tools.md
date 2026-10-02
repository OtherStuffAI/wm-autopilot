# Context Tree agent tools

These tools consume Tower's canonical context-tree v1 contract. They store no
component body, compulsory root or special definition document. Target records
remain authoritative. Jobs/apps and cross-scope component moves are excluded.
Source delivery and loaded-runtime activation are separate.

## Typed client and CLI

`FlightDeckPgClient.contextTree` provides `list`, `read`, `pathTo`, `references`,
`reference`, `create`, `update`, `link`, `unlink`, `deletePreview`, and
`confirmedDelete`. Every method requires workspace and scope; individual methods
also require component/reference IDs as appropriate. `read` and `pathTo` derive
from the complete flat scope listing because Tower has no single-component GET.
`pathTo` returns ancestors root-first, selected component's siblings and direct
children. Missing ancestors/cycles fail clearly. It reads no document bodies.

`list`/`references` walk bounded keyset pages until `next_cursor: null`, retain
Tower identity/capabilities, and report `complete: true` and `pages_read`. `limit`
is page size (1–200), never a total cap. Invalid envelopes or repeated cursors fail
without returning partial success. These are current-view reads, not a snapshot
against concurrent edits; reload before acting on inconsistent structure.

```sh
bun clis/wingman.ts flightdeck context-tree help
bun clis/wingman.ts flightdeck context-tree list --workspace <workspace-id> --scope <scope-id> --json
bun clis/wingman.ts flightdeck context-tree path <component-id> --workspace <workspace-id> --scope <scope-id> --json
bun clis/wingman.ts flightdeck context-tree reference <component-id> --reference <reference-id> --workspace <workspace-id> --scope <scope-id> --json
bun clis/wingman.ts flightdeck context-tree create --json-file create.json --workspace <workspace-id> --scope <scope-id> --json
```

Create input: `{"title":"API","parent_id":null}`. Update input:
`{"expected_row_version":3,"title":"Transport"}`. Link input:
`{"target_type":"task","target":{"record_id":"<task-id>"}}`.
Use `update|link <component-id> --json-file <file>`; unlink requires
`<component-id> --reference <reference-id> --expected-row-version <n>`.
CLI help works without credentials. Context commands require explicit routing
even in a session whose dispatch contains default workspace/scope hints.

## MCP contracts and authority

Eleven registered names share the prefix `flightdeck_context_tree_`:

| Suffix | Additional required parameters |
| --- | --- |
| `list` | optional `limit` |
| `read`, `path` | `component_id` |
| `references` | `component_id`; optional `limit` |
| `reference` | `component_id`, `reference_id` |
| `create` | `input: {title,parent_id?,sort_order?}` |
| `update` | `component_id`, `input: {expected_row_version,title?,parent_id?,sort_order?}` |
| `link` | `component_id`, `input: {target_type,target,sort_order?}` |
| `unlink` | `component_id`, `reference_id`, `expected_row_version` |
| `delete_preview` | `component_id` |
| `confirmed_delete` | `component_id`, `input: {confirmation_token,confirmed:true}` |

All require UUID `workspace_id` and `scope_id`. Input objects are strict. Mutations
retain the canonical `component|reference|deleted`, `identity`, `capabilities`,
`audit`, `outbox`, and `mutation_id` envelope. Reference `scope_id` is server-owned.
Reads use scope visibility (`scope.read` or existing active scope-channel read);
every edit and delete preview uses visibility plus `scope.manage` on Tower.
Inherited session routing and bot identity are not grants.

The stdio process may receive a public `WINGMAN_URL`. The standard MCP injector
also supplies `WINGMAN_BROKER_URL` at the host's loopback port. Context tools
prefer that local broker URL, so the helper receives a local request URL even
when the public Autopilot URL differs. The host-local check prevents forwarding
bearer credentials to a supplied remote Host. A legacy session with a public URL
and no local broker URL must receive the standard broker configuration; the tools
do not weaken the boundary to make that configuration work. The disposable HTTP
test uses a public tool URL plus a separate loopback broker and real registration
callbacks to prove this path.

The stdio registration delegates to the capability-protected host Flight Deck
helper. The host resolves the trusted current/inherited dispatch binding, rejects
workspace overrides, validates inputs again, and obtains every NIP-98 signature
through the caller's capability broker. It does not use the stored private runtime
signer as a denial fallback. Host caller credentials never resolve from ambient
agent environment overrides. Exact prepared URL (including cursor), method and
JSON body hash bind authentication. DELETE unlink signs its JSON body containing
the expected row version. Existing signing policies must permit the exact origin,
workspace path and method; tools do not broaden allowlists or grant Tower rights.
The current standard-agent workspace target already permits these methods.
Restrictive or missing policies fail and remain for an operator to resolve.

`reference` first reads current direct links/resolution, then reads only the
selected target via the normal doc body, file/object, or task route. Revoked or
missing target access returns only neutral unavailable status and structure
identity. It never returns an earlier resolution title after denial. `doc` maps to
`document` where existing viewers use that name. Link visibility never grants
source access. Artifact references return `status: external`, validated descriptor,
`access_checked: false`, and `/artifacts/<project>/<artifact>/` at the descriptor
origin; the agent tool does not fetch catalogs or private cross-origin content.
The WApp resolves latest under its own normal authentication/ACL. Follow-latest
is live context; record its resolved numbered version when evidence needs a
snapshot. Explicit versioned links stay pinned.

## Destructive workflow and errors

Obtain actual user authorization for the named subtree before deleting. Preview
returns `component_id,component_count,descendant_count,reference_count,
confirmation_token`. Present those counts and that linked content survives. Then
send that exact token with `confirmed:true` (CLI `--confirmation-token <token>
--confirm`) after explicit confirmation. The confirmation flag is client intent;
Tower receives only its canonical `{confirmation_token}` body.

No token default, automatic preview-refresh confirmation, write retry or offline
destructive queue exists. `409 delete_preview_changed` requires a fresh preview
and renewed confirmation. Update/unlink retain expected versions and surface
conflicts. CLI errors preserve Tower status/code/identity; MCP marks errors and
retains available broker/Tower envelopes. Permission and registration failures
are not empty success or permission to find keys/use SQL.

## Validation and activation

Focused tests cover pagination/traversal, exact signing and body hashes, selected
source ACL checks, CLI validation/help, schema/registration, inherited binding,
permissions/conflicts and explicit deletion. A real CapabilityBroker plus two
loopback disposable HTTP servers exercises registered MCP and typed-client
create/list/read/preview/conflict/delete. The target is a synthetic in-memory
route, not Tower persistence or a live Flight Deck convergence claim. Existing
broker, server capability gate, issuer and worker inheritance suites verify the
surrounding authority boundary.

WP6 must separately activate approved Tower/schema and Autopilot host handlers,
load the new MCP registrations in sessions, install only the requested portable
skill, verify actual delegated signing/Tower scope grants, and demonstrate live
human/agent convergence. Artifact installation/delegation/allowlist and hosted
latest resolution need separate evidence. No restart/deploy is implied here.
