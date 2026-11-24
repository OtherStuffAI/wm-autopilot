# Antigravity ACP agent

Autopilot offers **Antigravity** (`antigravity`) separately from the legacy
`gemini` agent. It starts `agy acp` directly over stdio using ACP version 1;
AgentAPI and the legacy Gemini CLI are not involved. The initial integration was
verified with Antigravity CLI 1.5.16 and Gemini 4 Neon.

Install the official Antigravity CLI on the Autopilot host and complete its Google
sign-in as the same operating-system user that runs Autopilot. Verify `agy models`
and `agy acp --help`. Autopilot uses that CLI's existing authentication; it does
not copy credentials, change legacy Gemini authentication, or require an API key
for subscription access. Account access and available models remain controlled
by Google.

Set `agents.antigravity_cli` in Instance Settings, or `ANTIGRAVITY_CLI`, if `agy`
is not on the service's PATH. A CLI path is a single executable, not a shell
command with arguments. Configuration changes marked as requiring restart take
effect after the operator restarts Autopilot from outside managed agent sessions.
Installing or changing source does not hot-load a new agent into a running server.

## Launch and model selection

After activation, select **Antigravity** in the normal session agent picker and
choose Neon Low, Medium, High or XHigh. `default` retains the CLI/account default;
it is not guaranteed to mean Medium. The equivalent supported CLI launch is:

```sh
bun clis/sessions.ts create antigravity \
  --directory /path/to/project --model gemini-4-neon-medium --bot-crypto
```

The model settings page's **Antigravity → Refresh from CLI** reads authenticated
`agy models` output. Saving that catalogue uses the existing `models.harnesses`
setting and updates the models offered by `/api/config`. Manual lists and resetting
to built-in defaults are also supported. Discovery errors leave the saved list
unchanged. The installed CLI/account catalogue is checked again on every launch,
including resume. Unknown or unconfirmed selections fail explicitly; Autopilot
never substitutes another model.

ACP represents Neon selection as model family `gemini-4-neon` plus
`thought_level` (`low`, `medium`, `high`, `xhigh`). Autopilot checks the requested
full ID against `availableModels`, sets the advertised configuration values, and
requires the returned configuration to confirm them. Session reporting retains
the full selected model ID.

## Sessions, tools and capabilities

Assistant chunks, thinking and tool updates use the existing ACP transcript/event
normalizer and session streaming. Follow-up prompts reuse the native session.
Autopilot records the returned native session ID; resuming uses `session/load`
only when the runtime advertises support. Load errors surface directly rather
than creating a fresh session. Cancellation uses `session/cancel` notification.

Tool requests use Autopilot's existing ACP permission UI and session approval
policy, including `ask` and `auto_approve`. The adapter does not pass
`--dangerously-skip-permissions`. Approval selects an actual advertised option;
unsupported options remain visible as errors. Explicit session/provider approval
settings retain their existing precedence.

The Wingman MCP stdio server is supplied through ACP `mcpServers`, with the
session's existing scoped broker capability and identity environment. Missing
required MCP/broker context prevents startup. Host signing secrets and unrelated
provider credentials are not inherited. No global Antigravity MCP configuration
or new Tower/Flight Deck contract is required.

## Verification and activation

Focused automated coverage includes configuration/UI catalogue selection,
transport registration, model confirmation and rejection, streamed follow-ups,
permission handling, cancellation, native load and ProcessManager rehydration:

```sh
bun test ./src/agents/antigravity-acp-adapter.test.ts
bun run typecheck
```

For an authenticated host smoke test, start an isolated adapter/session with
Neon Medium; request a short no-tools response, then ask a follow-up that depends
on earlier context. Reload its native session and repeat the context question.
Confirm assistant chunks reach the transcript. Request a harmless Wingman MCP
identity call and approve the specific request once. Verify a nonexistent model
fails before a prompt is sent. Never log broker capabilities or provider secrets.

After an authorized external restart, confirm `/api/config` offers `antigravity`,
launch it through the normal UI, send and follow up, and verify its model,
transcript and permission controls. An isolated adapter check validates the
integration source; it does not establish that the running service has loaded it.
