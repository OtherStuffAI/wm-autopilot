# Native project tools

An immutable pipeline can install app-owned tools on a `session.completedTurn`
code step using `agentTools`, a map of tool names to function names. The runner
requires each tool function to have a module hash and pins it with the run's
existing function snapshot. Tools are invoked by the native builder during the
turn, not by a later pipeline step or by parsing its final response.

The app supplies a reusable CLI or MCP client. Its local request is:

```json
{"sessionId":"opaque session","tool":"app.publish","args":{"validation":["actual check"]}}
```

`POST /api/mcp/wingman/project-tool` is host-local and authenticates the opaque
session capability with the existing broker identity endpoint. The token must
belong to the supplied session. The dispatcher requires a dedicated scoped native
session, one sending turn with an active lease, matching owner/cwd/binding,
matching active run/step, immutable tool configuration and unchanged function
hashes. It supplies native correlation and the saved run input to the handler;
caller arguments cannot replace execution authority. The app handler owns business
validation, publishing, replay receipts and failure recovery.

A request with `operation: "capabilities"` and `sessionId` returns the generic
`native-project-tools-v1` readiness protocol after capability authentication.
It grants no write authority and explicitly returns `hostFilesystemIsolation:false`
for the current native launcher. Handler output is ordinary typed tool feedback;
the native final answer remains independent.

New tool-enabled native sessions carry `nativeProjectTools:true` under the
completed-turn role. Their capability contains identity/refresh only, without
Tower reads/writes, signing, encryption, wallets or host administration. Legacy
completed-turn sessions retain their earlier recovery capabilities. An existing
live unscoped session cannot silently acquire tool authority; stop and native
resume it through the owned session lifecycle while preserving the thread.

This dispatcher scopes broker authority. It does not change the native SDK's
existing host filesystem sandbox. `danger-full-access` remains a known isolation
gap; do not use this API as evidence that untrusted builders cannot read unrelated
host files or credentials. An enforced host execution boundary is required before
advertising that guarantee. Autopilot source activation requires the operator's
explicit restart approval. Never restart it merely to test a WApp tool.
