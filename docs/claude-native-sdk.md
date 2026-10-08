# Claude native SDK sessions

`claude-use-native-sdk` is a managed, default-off feature flag. When enabled,
new Claude sessions persist `metadata.agentTransport: "claude-sdk"`. Existing
sessions retain their pinned transport, including after the flag changes.
Autopilot owns sessions, permissions, capability issuance and completion;
the official `@anthropic-ai/claude-agent-sdk` owns its Claude subprocess.
Tower and Flight Deck retain their existing publication and sync contracts.

## Authentication and launch

The adapter reuses the existing server-side `agents.claude_oauth_token` setting
for subscription sessions. It injects `CLAUDE_CODE_OAUTH_TOKEN` only into the
session's SDK subprocess environment. Credentials are excluded from browser
payloads and session metadata; SDK messages, permission labels and errors are
redacted before publication. Credits sessions retain their proxy credentials
and never receive subscription OAuth. Rehydrating credits without reissued
proxy credentials fails explicitly instead of changing billing mode.

The configured Claude executable (`CLAUDE_CLI`, normally `claude`) must support
the SDK initialization protocol. Startup uses the session working directory,
model, Claude Code system-prompt preset, user/project/local settings (including
project instructions), and session-private Wingman MCP configuration. The
Wingman MCP handshake is mandatory. Existing skip-permissions configuration is
preserved; otherwise tool approval uses Wingman's permission controls.

Official documentation checked on 2026-10-08:

- [Agent SDK overview and authentication](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)

The overview restricts third-party products offering claude.ai login or using
subscription rate limits without prior approval. Confirm the operator's saved
OAuth use is eligible before activation. The implementation retains the
existing explicitly requested injection; it does not introduce browser login
or merge subscription and credits authentication.

## Conversation and completion

Claude and Codex use shared thinking/tool roles and the existing Markdown
renderer. Tool calls/results are expandable; only exposed SDK thinking is
shown. Stable message identities reconcile streamed updates and snapshots in
Dexie without duplicating cards. Claude streams persist as `agent-streaming`,
render as ordinary conversation text, and promote to `assistant` only after a
successful root SDK result. Errors/interruption demote partial output and add
an error card. A crash-rehydrated stream therefore cannot become a final just
because the new subprocess is idle. Prior canonical Wingman history is hydrated
before a resumed adapter emits new messages.

Native session IDs are captured and persisted for follow-up/resume. An ID is
not completion evidence: native SDK final delivery requires stable runtime and
successful terminal output. Agent Direct retains durable exactly-once final
publication. Supervised dispatch captures one terminal callback; failed or
interrupted Claude turns cannot publish partial text as success. Night Watch
reflection prompts use the adapter for native sessions. Interrupt and session
stop close only the SDK-owned child process.

## Activation and acceptance

Source validation does not activate the running Autopilot. An operator must
restart it from outside managed sessions when restart authority is granted,
then enable `claude-use-native-sdk` in Feature Flags and start a new Claude
session. Leave the flag off until authentication and executable compatibility
are confirmed. Turning it off routes new sessions to AgentAPI; existing SDK
sessions remain pinned.

Use the same workflow for one new Claude SDK and one Codex SDK session:

1. Confirm readiness, selected working directory/model and project instructions.
   Confirm Wingman capability tools are available and execute a harmless read.
2. Check streamed Markdown/code, exposed thinking where supplied, and expandable
   tool inputs/results. Verify no credentials occur in payloads, logs or metadata.
3. Send a follow-up, interrupt an active turn, then send another follow-up.
   Stop a disposable session and check that its child exits.
4. Reload the conversation and resume the native session. Confirm earlier
   conversation remains visible and no cards duplicate.
5. In Agent Direct, verify one final reply for successful intake/replay and no
   partial final for interruption/error. Check final Markdown reaches Flight Deck.
6. Run a supervised disposable worker, verify one durable completion callback,
   then test interruption/error callbacks and a reflection/end-prompt hook.
7. Independently verify credits proxy authentication and billing remain separate.

The browser fixture in `scripts/native-sdk-parity.browser.test.ts` uses real
Alpine/Dexie with synthetic provider events. Run it with `PLAYWRIGHT_MODULE`
pointing to an installed Playwright module and optionally `BROWSER_EXECUTABLE`
for Chrome. `SDK_PARITY_SCREENSHOT` writes review evidence to an ignored path.
It proves source rendering/promotion/reload, not live OAuth/provider delivery.
