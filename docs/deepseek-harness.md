# DeepSeek Harness in Autopilot

DeepSeek Harness is agent type `deepseek`, label **DeepSeek Harness**, transport
`deepseek-acp`. Autopilot launches ACP directly, without AgentAPI, and waits for
initialization and session negotiation before accepting work. The session dialog,
CLI, API, and supervised dispatch use the shared agent catalogue.

## Install and configure

The validated runtime is **@deepseek-ai/dsh 0.2.0-rc.2**, speaking ACP v1 over
newline-delimited JSON-RPC stdio. Use Node.js `^22.19.0` or `>=24.0.0`; the
initial isolated verification used Node 26.3.1 and Bun 1.3.0. Install into an
operator-managed directory, rather than using an unpinned `npx` launch:

```sh
npm install --prefix "$HOME/.local/share/wingman/deepseek-harness/0.2.0-rc.2" \
  @deepseek-ai/dsh@0.2.0-rc.2 --save-exact --no-audit --no-fund
"$HOME/.local/share/wingman/deepseek-harness/0.2.0-rc.2/node_modules/.bin/dsh" --version
```

With npm versions that defer dependency install scripts, review the pending
scripts and approve the installed runtime's subprocess helper and native modules
(`@deepseek-ai/dsh-subprocess-local`, `koffi`, `node-pty`, `protobufjs`), then rebuild
those packages from the install directory. Native tools require their helpers;
a protocol handshake alone does not exercise every native tool.

In **Instance Settings** configure:

- **DeepSeek Harness ACP Executable** (`agents.deepseek_acp_cli`): the absolute
  installed `node_modules/.bin/dsh` path. Environment import: `DEEPSEEK_ACP_CLI`.
- **DeepSeek API Key** (`integrations.deepseek_api_key`): a DeepSeek provider key.
  Environment import: `DEEPSEEK_API_KEY`. The existing settings store encrypts
  secrets at rest and masks them in the settings UI. Never put a value in a CLI
  argument, task comment, log, tracked file, or session metadata.

Autopilot checks the executable's reported version against the validated pin
before launch. Missing paths, unsupported versions, missing credentials, and
missing broker context fail with actionable errors. Sign in and launch with an
active Wingman agent identity so the capability broker can bind the session.
Changing the configured runtime or secret is marked as requiring restart by the
existing settings workflow. Existing sessions keep their original process.

## Session behavior and privacy

The launch is `dsh --profile acp --patch <repo>/config/agents/deepseek-acp.patch.yml`.
The final overlay explicitly disables `session-log-deepseek`,
`session-telemetry-otel`, and `product-telemetry-otel`; the process also receives
`DSH_TELEMETRY_DISABLED=1` and `DSH_TELEMETRY_MODE=DISABLED`. Upstream's base
profile normally enables DeepSeek session-log upload, so telemetry opt-out alone
is insufficient. Local native session persistence remains enabled.

The process launches in a dedicated Harness home, normally
`$HOME/.wingman/deepseek-harness`. It receives the project's working directory
through ACP, avoiding import of the project's `.env` as a process environment.
An explicitly supplied definition environment `DSH_HOME` can select another
home. Keep that home private and free of host signing secrets; do not share it
with an unrelated desktop runtime or change it when resuming a session.

Wingman MCP uses the existing stdio server and broker. ACP receives an absolute
Bun command, the server path, and the session's short-lived opaque capability.
Raw Nostr signing keys are excluded. Provider credentials are passed only to
the Harness process and are excluded from the MCP configuration.

The selector offers **default**, owned by the installed ACP profile (the
validated release selects `deepseek-official` / `deepseek-v4-flash`). API model
overrides are accepted only when advertised by the runtime; grouped ACP options
use opaque JSON `[provider, model]` values and the adapter confirms selection.
The shared OpenRouter catalogue is not applied to DeepSeek.

Messages, thinking and tool updates flow through the shared ACP normalizer.
Permission policy follows Autopilot's configured `ask` or `auto_approve` policy;
`ask` exposes upstream Allow once/Reject choices. Cancellation sends the
`session/cancel` notification and cancels pending permission requests. Completed
prompt RPCs return the adapter to stable, allowing supervised dispatch to detect
completion using the existing lifecycle.

Native IDs are saved through Autopilot's existing native-session metadata.
DeepSeek advertises **session/resume**, rather than **session/load**. Native
resume creates a new Wingman session and broker capability, reopens the persisted
DeepSeek session in the same Harness home and directory, and retains conversation
history upstream. ACP resume does not replay old messages to the client; inspect
the original Wingman transcript for earlier turns. Do not resume a native ID
while another process owns it.

## Verification and activation

Run focused regression tests:

```sh
bun test ./src/agents/deepseek-acp-adapter.test.ts \
  ./src/ui/common/session-dialog.test.js ./src/config.test.ts
bun run typecheck
bun test ./src ./clis ./scripts
bun run lint:check
bun run security:audit
bun build src/index.ts --target bun --external pm2 --outdir tmp/docs/handoffs/deepseek-build
```

Run real protocol verification with the installed pinned executable:

```sh
DEEPSEEK_ACP_CLI="$HOME/.local/share/wingman/deepseek-harness/0.2.0-rc.2/node_modules/.bin/dsh" \
  bun scripts/smoke-deepseek-acp.ts
```

Within a managed Wingman session, add `--wingman-mcp` to also verify real MCP
stdio startup and tool discovery with that session's existing broker capability.
It still performs no MCP tool invocation. Never copy the capability into docs or
logs. If unfiltered `bun run validate` discovers historical test checkouts under
ignored `tmp/`, use the explicit repository test directories shown above;
whitespace, typecheck, lint, security audit and reports remain separate required
checks. PM2 remains an external runtime dependency for the server bundle because
its installed package references an unavailable `../../tools/prompt` internally.

This smoke creates its own temporary home and processes, uses an invalid
placeholder credential, checks initialize/new/close/resume across processes,
and never prompts a model. It does **not** prove model authentication, live
Wingman MCP execution, or supervised completion with a real provider.

Source checks do not activate a running Autopilot. After review, an operator must
configure the runtime and secret, obtain Pete's approval acknowledging active
session interruption, and restart Autopilot **from outside its managed agent
sessions** using the instance's existing launch method. Do not start a second
server on the live port. Then:

1. Refresh Autopilot; confirm DeepSeek Harness appears in the session selector
   and `/api/config` catalogue.
2. Create a DeepSeek session in an isolated project with permission policy `ask`.
   Ask for a small file write, approve once, and verify the file and streamed
   tool/message events. Exercise cancellation during a separate turn.
3. Stop that session, use native resume, and verify retained context.
4. Dispatch `deepseek` through the existing supervised worker flow, ask it to
   read a file and use a read-only Wingman MCP tool, and inspect the manager's
   durable completion callback. Rick reviews evidence and moves the task to
   review assigned to Pete.

Upstream contracts were verified against the installed 0.2.0-rc.2 packages and
[source](https://github.com/deepseek-ai/deepseek-harness) (master
`5badb15009ae1756c3afe0ae0cef1faafc290ccc`) on 2026-10-06. See the
[Harness product page](https://www.deepseek.com/en/harness/) and the upstream ACP,
ACP application profile, and base profile for version-specific behavior.
