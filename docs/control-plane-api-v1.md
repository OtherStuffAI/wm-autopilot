# Autopilot control-plane API v1

Autopilot exposes a public signed connection package and narrowly scoped NIP-98 reads compatible with Flight Deck build 2050. Contract types and generic public fixtures live in `src/control-plane/contracts.ts` and `src/control-plane/fixtures.ts`.

## Connect package and owner selection

Request `GET /api/control-plane/v1/connect-package?owner_npub=<owner-npub>`. Owner selection is required because Flight Deck calls the exact signed paths and cannot infer which owner space should authorize discovery. Autopilot does not substitute the installation signer, an operator key, or another raw-key fallback for this owner.

The response envelope is `{ manifest, signature }`. A representative wire shape is:

```json
{
  "manifest": {
    "kind": "wingman_autopilot_connect",
    "version": 1,
    "generated_at": "2026-01-01T00:00:00.000Z",
    "installation": { "id": "autopilot_<stable-id>", "npub": "npub1..." },
    "endpoints": { "fips": "http://npub1....fips:3601", "https": "https://autopilot.example" },
    "api": {
      "version": 1,
      "capabilities": ["health", "agents.read", "agents.overview.read", "agents.pipelines.read", "agents.schedules.read", "agents.triggers.read"],
      "health_path": "/api/owners/npub1owner.../control-plane/v1/health",
      "agents_path": "/api/owners/npub1owner.../control-plane/v1/agents"
    }
  },
  "signature": { "kind": 27236, "content": "<canonical manifest JSON>" }
}
```

Object keys in `signature.content` are recursively sorted; array order is retained. The event signer, `manifest.installation.npub`, and the npub in the exact FIPS origin must match. Package generation fails with `503` if FIPS is unavailable or exposes a different service identity. HTTPS is descriptive metadata only and is never a fallback.

Consumers must reject unknown versions, invalid or tampered signatures, expired generation times, identity mismatches, unsafe paths, and credential-like fields or secret values. The package contains no private key, bearer token, bunker URI, or reusable signing secret.

## Authenticated reads

The package advertises these owner-specific paths directly:

- `GET /api/owners/:ownerNpub/control-plane/v1/health`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents`

Health returns:

```json
{ "ok": true, "installation_id": "autopilot_<stable-id>", "installation_npub": "npub1...", "api_version": 1 }
```

Discovery returns:

```json
{
  "installation_id": "autopilot_<stable-id>",
  "agents": [{
    "agent_id": "agent-example",
    "bot_npub": "npub1...",
    "name": "Example Agent",
    "description": "Public description",
    "can_instruct": true,
    "paths": {
      "overview": "/api/owners/npub1owner.../control-plane/v1/agents/agent-example/overview",
      "pipelines": "/api/owners/npub1owner.../control-plane/v1/agents/agent-example/pipelines",
      "schedules": "/api/owners/npub1owner.../control-plane/v1/agents/agent-example/schedules",
      "triggers": "/api/owners/npub1owner.../control-plane/v1/agents/agent-example/triggers"
    }
  }]
}
```

The `paths` values are the exact owner-space URLs that Flight Deck signs with NIP-98. The legacy overview alias `GET .../agents/:agentId` remains accepted; new consumers should use the advertised `/overview` path.

## Agent Space reads

The discovery payload advertises four agent-specific reads:

- `GET /api/owners/:ownerNpub/control-plane/v1/agents/:agentId/overview`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents/:agentId/pipelines`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents/:agentId/schedules`
- `GET /api/owners/:ownerNpub/control-plane/v1/agents/:agentId/triggers`

Overview extends the discovery item with public profile fields, public capabilities, and enabled/archive state. Pipelines returns reusable definition summaries separately from agent assignments, defaults, and workspace/scope/channel overrides:

```json
{
  "installation_id": "autopilot_<stable-id>",
  "agent_id": "agent-example",
  "bot_npub": "npub1...",
  "availability_mode": "explicit",
  "default_mode": "explicit",
  "available_definitions": [{
    "pipeline_definition_id": "shared:0123456789ab",
    "name": "Example pipeline",
    "description": "Reusable library definition",
    "scope": "shared",
    "version": 2,
    "tags": ["example"]
  }],
  "assignments": [{ "pipeline_definition_id": "shared:0123456789ab" }],
  "defaults": [{ "pipeline_definition_id": "shared:0123456789ab" }],
  "overrides": [{ "kind": "channel", "context_id": "channel-example", "pipeline_definition_id": "shared:0123456789ab" }],
  "missing_definition_ids": []
}
```

`availability_mode: "implicit_all"` is the explicit backward-compatible state for an agent with no availability configuration: all definitions currently loaded from the established shared/user library are assigned. `default_mode: "implicit_library"` similarly exposes definitions carrying the existing `default: true` marker. Once bindings are explicitly configured, an empty list means none. Bindings store definition IDs only; definition JSON remains in the shared/user definition stores and runtime history remains in the pipeline store. A referenced definition that is no longer loadable is reported in `missing_definition_ids` rather than silently substituted or hidden.

Schedules and triggers are split by trigger kind. Both retain the execution `bot_npub` and repeat the stable `agent_id` on every item. Schedule rows expose cron/timezone, action and run timing. Trigger rows expose file-watcher type/pattern, action and last-run timing. Neither response exposes wrapped keys, prompts, working directories, pipeline input, or other internal scheduler state.

Existing scheduler rows are reconciled once by the exact owner plus `bot_npub`, then persisted with `agent_id`; subsequent filtering uses only stable `agent_id`. New and updated scheduler rows bind `agent_id` when their active bot identity resolves to an owner-managed agent.

Every protected request passes through the normal API router and shared NIP-98 verifier. Authorization binds the exact URL including query, method, and body hash when a body exists, and rejects replayed events. The owner may read the agents it manages. A delegated signer requires an active exact-owner `control-plane:read` delegation, is restricted by `resourceFilters.agentIds`, and must be an instructor for every returned agent. Workspace membership is not authority. Unauthorized agent lookups return `404`.

All package, health, discovery, and overview responses use `cache-control: no-store`. Stable installation and agent IDs are intended for downstream Tower connection records.
