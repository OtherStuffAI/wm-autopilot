# Business WApp + Autopilot Pattern

## Purpose

This pattern describes how to build business-specific apps on Wingman Be Free without turning Flight Deck into the place where every custom workflow lives.

A Business WApp owns the customer-specific interface, local operational data, and app-specific business rules. Autopilot owns AI work execution: pipelines, agent sessions, code steps, task creation, and follow-on orchestration. Both sides expose NIP-98-authenticated APIs so either side can call the other when authorized.

## Core Model

The system has two cooperating runtimes:

- The WApp is the business app. It contains the UI, local SQLite or app-specific database, domain routes, webhook receivers, and any deterministic business logic that should live close to the app.
- Autopilot is the AI worker. It exposes NIP-98 APIs for starting pipelines, checking runs, creating tasks, and managing app-triggered work.

The WApp should be useful without AI for normal CRUD and workflow state. When judgement, generation, retrieval, classification, or multi-step work is needed, the WApp triggers Autopilot.

Autopilot should not need direct database access to the WApp. If an agent or pipeline needs more app context, it calls the WApp's NIP-98 API using a bot key or delegated capability granted by the WApp.

## Responsibilities

WApp responsibilities:

- user-facing business UI;
- local Nostr login and session cookies;
- local SQLite or app-specific storage;
- domain API routes;
- webhook endpoint for pipeline results;
- authorization policy for users, bots, and app capabilities;
- durable local audit trail of AI-triggered requests and responses.

Autopilot responsibilities:

- NIP-98 API for pipeline and task triggers;
- pipeline definitions and run state;
- agent session lifecycle;
- deterministic code steps;
- follow-on pipeline calls;
- task creation and updates when AI work should become visible coordination work;
- callback delivery to the WApp webhook.

Tower responsibilities:

- workspace identity, groups, encrypted shared records, storage metadata, and graph APIs;
- optional graph memory through Postgres/AGE;
- Flight Deck WApp launcher records and access groups.

Flight Deck responsibilities:

- discovery and launching of WApps through app cards;
- human coordination around tasks, chats, approvals, docs, and flows;
- not custom business UI for every customer-specific process.

## Request Flow

1. A user signs into the WApp with a Nostr identity and uses a local UI such as chat, review, approval, quoting, scheduling, reporting, or a custom operational workflow.
2. The WApp stores local state and decides that AI work is required.
3. The WApp calls Autopilot with NIP-98 auth, targeting a specific pipeline by id, slug, or configured trigger name.
4. The trigger payload includes the latest user input, relevant local history or references, the WApp record ID, the WApp request ID, and a webhook callback contract.
5. Autopilot starts the pipeline. Pipeline steps can run code, start agent sessions, create tasks, query Tower graph memory, or call other pipelines.
6. If the agent needs more app context, it calls the WApp's NIP-98 API using an allowed bot key or delegated read capability.
7. If the agent needs to update app state before final completion, it calls the WApp's NIP-98 API using an allowed edit capability.
8. The pipeline eventually posts one final result to the WApp webhook.
9. The WApp verifies the webhook token or NIP-98 signature, updates local state, and renders the result to the user.

The webhook is the completion path. Direct polling can exist for diagnostics, but the normal user experience should not depend on polling a pipeline run until completion.

## NIP-98 API Contract

Both sides must treat NIP-98 as the API boundary.

WApp to Autopilot:

- WApp backend signs server-to-server API calls when it owns a service key.
- Browser-initiated calls can use NIP-07 signing when the request must represent the signed-in user directly.
- Autopilot verifies signer, capability, method, URL, and payload hash.
- Autopilot records the actor npub and effective owner for audit.

Autopilot to WApp:

- Agent sessions and pipeline code steps call WApp APIs with NIP-98.
- The WApp allowlist controls which bot npubs can read or edit app data.
- Read and edit capabilities should be separate. A bot with read access can gather context but cannot mutate local business records.
- The WApp should log every bot-authenticated read or edit with run ID, pipeline ID, actor npub, and request ID where available.

Webhook delivery:

- The webhook can use a short-lived bearer token, NIP-98, or both.
- For demos, a signed random callback token is acceptable.
- For production WApps, prefer NIP-98 plus a run-scoped callback token so the WApp can verify both actor identity and request intent.

## Trigger Payload Shape

Recommended Autopilot trigger payload:

```json
{
  "source": "business-wapp",
  "wappId": "wapp_123",
  "appId": "app_123",
  "requestId": "req_123",
  "userNpub": "npub1...",
  "chatId": "chat_123",
  "message": "latest user input or command",
  "history": [],
  "localContext": {
    "records": [],
    "references": []
  },
  "capabilities": {
    "wappRead": true,
    "wappEdit": false
  },
  "webhook": {
    "url": "https://wapp.example/api/pipeline-webhook",
    "authHeader": "x-wapp-callback-token",
    "token": "run scoped secret",
    "expectedSignerNpub": "npub1..."
  }
}
```

Use direct embedded data for compact context. Use references when data is large, sensitive, or likely to change before the agent reads it. References must be resolvable through WApp or Tower NIP-98 APIs.

## WApp API Shape

Every Business WApp should expose a small, predictable API surface:

```txt
GET    /api/health
GET    /api/me
POST   /api/auth/challenge
POST   /api/auth/verify
GET    /api/ai/requests
GET    /api/ai/requests/:requestId
POST   /api/ai/trigger/:pipelineSlug
POST   /api/ai/webhook
GET    /api/agent/context/:requestId
POST   /api/agent/edits/:requestId
```

The exact business routes can vary. The AI integration routes should stay consistent across WApps so Autopilot agents and pipeline templates can reuse the same assumptions.

## Autopilot API Shape

Autopilot should provide stable NIP-98 routes for this pattern:

```txt
POST   /api/pipelines/triggers/http/:pipelineSlug
GET    /api/pipelines/runs/:runId
GET    /api/pipelines/runs/:runId/steps
POST   /api/tasks
GET    /api/apps
GET    /api/apps/:appId
```

The WApp should not hand-edit Autopilot registry files or pipeline stores. All runtime control should go through APIs or CLIs that call those APIs.

## Capability Model

Use explicit capability grants rather than assuming a bot can do everything because it has a Nostr identity.

Recommended capabilities:

- `wapp:read`: read app context for a specific app, request, workspace, or user.
- `wapp:edit`: mutate app records for a specific app and bounded record family.
- `autopilot:pipeline:trigger`: trigger an allowed pipeline.
- `autopilot:pipeline:read`: inspect pipeline run status and outputs.
- `autopilot:task:create`: create tasks from WApp workflows.
- `tower:graph:read`: query graph memory through Tower.

Capability scope should include actor npub, app id, WApp id, workspace owner npub, optional scope or group id, expiry, and allowed HTTP methods.

## Local Data And Shared Data

Keep data where it naturally belongs:

- WApp SQLite or app DB: local operational state, app-specific records, drafts, request logs, user preferences, and domain-specific tables.
- Tower records: workspace-shared coordination records, WApp launcher metadata, tasks, approvals, docs, groups, and encrypted shared state.
- Tower graph: cross-workspace or long-lived memory that agents need to retrieve semantically.
- Autopilot pipeline DB: run state, step outputs, callbacks, and diagnostics.

Do not push all WApp data into Tower just so agents can read it. Prefer a WApp NIP-98 context API that returns only the data needed for the current run.

## Pipeline Design Rules

Pipelines used by Business WApps should follow this shape:

1. Normalize and validate the WApp request.
2. Extract entities, intent, and required capabilities.
3. Query relevant WApp context through NIP-98 when needed.
4. Query Tower graph memory when useful.
5. Consolidate user input, history, WApp context, and graph context.
6. Run the answer, decision, generation, or action agent.
7. Optionally call WApp edit APIs for bounded state changes.
8. Send one final webhook response.

Intermediate progress can be written to pipeline logs or WApp request status, but the default contract is one final user-facing response.

## Security Rules

- The WApp backend, not the browser, enforces local data authorization.
- Autopilot routes must verify NIP-98 method, URL, payload hash, signer, and capability.
- WApp agent APIs must verify NIP-98 method, URL, payload hash, signer, and capability.
- Bot read and edit access must be separate.
- Webhook tokens must be run-scoped and short-lived where practical.
- Local SQLite files remain local to the WApp container and should not be exposed through static file serving.
- Logs must not include callback tokens, Nostr private keys, or raw sensitive payloads.

## Business App Template Requirements

A reusable Business WApp template should include:

- Nostr login and server-side allowlist enforcement;
- local SQLite with migrations;
- AI request table;
- Autopilot trigger client with NIP-98 support;
- pipeline webhook receiver;
- agent context API with read capability checks;
- optional agent edit API with edit capability checks;
- health endpoint;
- app card metadata and WApp publication manifest;
- example pipeline JSON and test webhook script.

## Open Implementation Work

- Generalize the current chat WApp trigger client into a reusable package or template module.
- Add a reusable WApp NIP-98 verifier for agent-to-WApp APIs.
- Add an Autopilot capability model for app-triggered pipelines.
- Add app-card UI affordances for selecting allowed pipelines per WApp.
- Add a standard WApp request/run dashboard.
- Add tests for bidirectional NIP-98 calls between a WApp and Autopilot.
- Decide whether production webhook delivery requires NIP-98, callback token, or both by default.
