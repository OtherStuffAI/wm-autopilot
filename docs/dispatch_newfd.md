# Flight Deck Agent Dispatch Settings

This note explains the current Autopilot Agent sheet for kind 33357 / new Flight Deck workspace dispatch.

## Mental Model

A Flight Deck workspace connection gives Autopilot a workspace event stream. The Agent sheet decides what the selected agent profile should do when a matching event arrives.

There are four layers:

1. Workspace connection: the 33357 / Flight Deck PG subscription.
2. Agent profile: the bot identity and broad defaults for that agent. <comment>I would call this the profile for that "worksapce agent" autopilot is an agent, the workspace agent is the context for the agent in that workspace</comment>
3. Workspace settings: defaults and context for this agent in this workspace.
4. Event policies and target overrides: per-event, per-scope, and per-channel routing.

The connection answers "can this agent see this workspace?" The policy settings answer "what pipeline or prompt should handle each event?"

## Pipeline Selection Order

When an event is dispatched, Autopilot resolves a pipeline in this order:

1. Event policy pipeline.
2. Channel override pipeline.
3. Scope override pipeline.
4. Workspace default pipeline.
5. Profile default pipeline.
6. Built-in default pipeline.

The first non-empty value wins.

### Profile Default Pipeline

The profile default pipeline is a fallback for this agent profile across workspaces.

Use it when an agent should normally handle events the same way everywhere. For example, a general "implementation task responder" profile can use one default task pipeline unless a workspace overrides it.

### Workspace Default Pipeline

The workspace default pipeline is a fallback for this agent profile in one workspace.

Use it when the same agent should behave differently in this workspace than it does globally. It takes precedence over the profile default, but it is still overridden by event policy, channel, and scope-specific pipeline settings.

## Event Policies

Event policies are per-event controls. Each row has:

- Enabled: whether this event type can dispatch.
- Quiet: suppresses dispatch even if the policy is enabled.
- Action: the intended behavior for the agent.
- Pipeline: the pipeline to use for this event type.
- Prompt context: event-specific guidance appended to the runtime context.

If `Enabled` is false or `Quiet` is true, Autopilot suppresses dispatch for that event. If dispatch proceeds, the policy can become a synthetic dispatch route with priority 0, so it can launch the selected pipeline even when no explicit route row exists.

## Event Types

| Event type | Intended meaning | Default |
| --- | --- | --- |
| Direct message | A direct chat to the agent. | Enabled, respond |
| Chat mention | The agent is mentioned or selected in chat. | Enabled, respond |
| Chat observe | Chat activity the agent can watch but should not answer by default. | Disabled, observe, quiet |
| Document created | A document appears that the agent may index or process. | Disabled, index, quiet |
| Document comment tagged | A document comment asks for the agent. | Enabled, respond |
| Document comment observe | Document comment activity the agent can watch. | Disabled, observe, quiet |
| Task assigned | A task is assigned to this agent. | Enabled, work |
| Task comment | A task comment should be considered for response. | Enabled, respond |
| Approval assigned | An approval needs the agent to inspect or notify. | Enabled, notify |
| Flow step assigned | A flow step is assigned to the agent. | Enabled, run_flow_handler |

Some event types are ahead of the current PG event mapping. The UI can store policy for all listed event types, but Autopilot only applies them when the runtime maps an incoming workspace event to that event type.

## Actions

Actions are policy intent. They are used by Autopilot to decide whether to suppress legacy dispatch, and they are included in `profileRuntime.defaultAction` for pipelines.

| Action | Meaning |
| --- | --- |
| respond | Produce a chat/comment reply. |
| ignore | Do not dispatch. |
| observe | Watch or record context without responding. |
| index | Read/index content for future use. |
| work | Act on a task assignment. |
| acknowledge | Acknowledge receipt without doing deeper work. |
| notify | Surface or summarize something for a human. |
| process | Run a processing pipeline. |
| run_flow_handler | Execute flow-step handling logic. |

Important implementation detail: pipelines receive the action, but the pipeline definition must interpret it. Selecting `notify` does not magically send a notification unless the selected pipeline implements notification behavior.

## Contexts

Contexts are additive guidance. They do not change the connection and they do not select a pipeline by themselves.

Runtime context is resolved in this order:

1. Profile prompt context.
2. Workspace context.
3. Matching scope context.
4. Matching channel context.
5. Event policy prompt context.

For pipeline dispatch, the resolved context is passed in the pipeline input as:

```json
{
  "profileRuntime": {
    "eventType": "task_assigned",
    "defaultAction": "work",
    "quietMode": false,
    "pipeline": {
      "pipelineDefinitionId": "agent-dispatch-task-response",
      "source": "workspace_default"
    },
    "appendedContext": [
      {
        "kind": "agent_profile",
        "targetId": "profile id",
        "eventType": null,
        "contextText": "Profile-level guidance"
      },
      {
        "kind": "workspace",
        "targetId": null,
        "eventType": null,
        "contextText": "Workspace-level guidance"
      }
    ]
  }
}
```

For legacy non-pipeline chat/task dispatch, Autopilot formats the same resolved context into a text block and passes it as `runtimeContext`.

## Scope And Channel Overrides

Scope and channel rows let a workspace specialize the same agent for a narrower area.

Examples:

- Route a `Support` channel to a triage pipeline.
- Route an `Engineering` scope to an implementation pipeline.
- Add channel-specific context such as "Use customer-safe language here."
- Add scope-specific context such as "This scope owns the billing service."

Target overrides sit above workspace/profile defaults but below an explicit event policy pipeline.

## Practical Defaults

For the current new Flight Deck setup:

- Put stable, cross-workspace agent behavior in profile defaults.
- Put customer/workspace-specific instructions in workspace context.
- Use workspace default pipeline when this workspace needs a different normal pipeline.
- Use event policy pipeline when a specific event type should always go somewhere specific.
- Use scope/channel overrides when the same event type should route differently by location.
- Keep `Quiet` on for observe/index style policies until a pipeline exists that handles them safely.

## Current Gap To Track

The new PG event connection is active and workspace-first. Autopilot records the Flight Deck PG event cursor and event diagnostics.

The remaining implementation layer is PG-native event mapping: converting PG chat/task/comment events into pipeline dispatch inputs without reusing the old v4 encrypted-record model. Once that is complete, these policy settings become the main routing surface for new Flight Deck events.