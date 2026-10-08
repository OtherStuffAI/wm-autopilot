# Session provider approvals

The managed **Session provider auto-approval** flag (`session_provider_auto_approve`)
ships off. Administrators manage it in Settings → Feature Flags using Off, Admin
only, or On. Admin-only runtime eligibility follows the session owner, rather
than the person viewing the session.

With the flag effective, **Always approve for this session** appears in the new
session dialog's advanced options and in Session Details. Check it before
starting a supported session, or save it on an existing session to resolve its
pending provider tool requests and approve subsequent requests. Uncheck and save
to return to manual provider consent. Session Details also shows saved consent
when the flag is off so it can be removed.

The durable session metadata field is `providerApprovalPolicy`, with values
`always` and `manual`. The existing authenticated session creation and metadata
APIs accept it. Updating consent does not replace the session's transport,
provider credentials, charge identity or native session identity. Recovery and
native resume retain it; unrelated sessions and conversation branches do not
inherit it. Resolved permission cards are removed through SSE and Dexie.

Turning the managed flag off immediately suspends opted-in sessions. Requests
already executed cannot be recalled. Future requests use manual consent; saved
opt-ins remain dormant and reactivate if the flag becomes effective again.
Removing a session's opt-in keeps it manual after the flag is enabled again.
An unset policy preserves the previous transport behavior, including existing
ACP runtime settings. An explicit session policy supersedes that ACP setting.

## Provider support

| Pinned transport | Behavior |
| --- | --- |
| `claude-sdk` | Pending and future tool requests are approved through `canUseTool`. Explicit session policy uses default permission mode, overriding the launch's skip-permissions option. Previously remembered per-tool consent is cleared on revocation. Interrupted requests are denied and removed. |
| `codex-acp` | Runtime permission requests receive the provider's `allow_once` option while opted in. No persistent provider allow rule is installed. Requests without a one-time allow option stay visible for manual handling. Interrupt/dispose returns ACP cancellation. |
| `codex-sdk` | Already noninteractive: the existing SDK uses `approvalPolicy: never` and `danger-full-access`. It has no interactive approval response channel. The new control is disabled; switching it to manual is unsupported. Explicit provider rules may still deny execution. No transport migration is performed. |
| `agentapi` and other transports | This new session policy is unsupported; the control is disabled and existing behavior remains. |

Codex SDK's `request_user_input` is not an interactive channel supplied by this
integration. Codex ACP methods outside its supported permission protocol surface
an explicit unsupported-request error. This feature does not add a general
question-answer bridge to either transport.

## Claude questions

`AskUserQuestion` requires `updatedInput.answers` when a host supplies answers.
Returning bare tool approval does not constitute an answer. Under automatic
session consent, Autopilot instead denies this interactive question with an
explicit continuation instruction: use supplied recommended defaults or agent
judgment for optional implementation choices, record choices and reasons, and
stop/report when essential information or explicit human authorization is absent.
The original question and instruction are recorded as tool activity. The agent's
actual selected choices appear in its response; no human answer is fabricated.

This is model-directed continuation, not a deterministic classifier of whether
a question is essential. A real isolated Claude SDK probe verified that two
optional recommended choices finish without another input wait, and that missing
essential information plus human restart authorization produce a blocker.

The provider consent policy grants no broker capability, Tower authorization,
credentials, deployment permission or Autopilot restart authority. It does not
auto-answer MCP elicitation, authentication dialogs or explicit human approvals.

## Validation and activation

Focused source tests cover pending/future consent, isolation, revocation,
interruption, metadata recovery/native resume, transport limits and SSE removal.
A browser fixture exercises the real new/existing session controls and JavaScript
MIME serving. Run its test with `PLAYWRIGHT_MODULE` pointing to an installed
Playwright module and optionally `BROWSER_EXECUTABLE` pointing to Chrome.

Backend changes require an operator restart outside active managed sessions.
After activation, enable the flag and test an opted-in Claude SDK session beside
a manual session, pending requests, disable/re-enable, interrupt, reload and
native resume. For Codex consent controls, select Codex ACP when creating a new
session; existing Codex SDK sessions retain their pinned noninteractive transport.
Source and isolated provider tests do not prove activation in a running server.
