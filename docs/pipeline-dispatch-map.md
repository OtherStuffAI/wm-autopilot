# Autopilot Pipeline Dispatch Map

Last checked: 2026-06-23.

This map covers the built-in Autopilot dispatch pipelines seeded by `src/pipelines/pipeline-loader.ts` and the Flight Deck PG subscription paths in `src/agent-chat/subscription-runtime.ts`.

## Dispatch Entry Points

```mermaid
flowchart LR
  FD[Flight Deck PG event] --> Policy[Agent profile policy resolution]
  Policy -->|chat_mention| Chat[fd-agent-dispatch-chat]
  Policy -->|task_assigned or task_dispatch| TaskResp[fd-agent-dispatch-task-response]
  Policy -->|task_comment or document_comment_tagged| CommentResp[fd-agent-dispatch-comment-response]
  Policy -->|document_invocation| DocInvoke[fd-document-invocation]
  Policy -->|task_invocation| TaskInvoke[fd-task-invocation]

  Chat --> ChatReturn[chat thread reply or task-backed child work]
  TaskResp --> TaskReturn[task comment and task state]
  CommentResp --> CommentReturn[comment reply on task or document]
  DocInvoke --> DocReturn[document edits or comments, then channel message]
  TaskInvoke --> TaskInvokeReturn[task comment, optionally child pipeline]
```

Default policy targets:

| Event type | Default pipeline | Minimum routing data | User-visible return |
| --- | --- | --- | --- |
| `chat_mention` | `fd-agent-dispatch-chat` | `workspaceId`, `scopeId`, `channelId`, `threadId`, triggering `messageId`, message body/sender | Reply in the same chat thread, or a created task plus chat status |
| `task_assigned` / `task_dispatch` | `fd-agent-dispatch-task-response` | `workspaceId`, `taskId`, task title/body/state, scope/channel when available | Task comment, task state update, optional child closeout |
| `task_comment` | `fd-agent-dispatch-comment-response` | `workspaceId`, `taskId`, `commentId`, comment body/sender | Reply comment on the task |
| `document_comment_tagged` | `fd-agent-dispatch-comment-response` | `workspaceId`, `documentId`, `commentId`, comment body/sender | Reply comment on the document |
| `document_invocation` | `fd-document-invocation` | `workspaceId`, `target documentId`, invocation prompt, channel/scope | Agent edits/comments on document, then channel message with document mention and summary |
| `task_invocation` | `fd-task-invocation` | `workspaceId`, `target taskId`, invocation prompt, channel/scope | Task comment; if child work starts, child pipeline reports back to same task |

## Chat Dispatch

```mermaid
flowchart TD
  ChatEvent[Chat mention event] --> Hydrate[hydrate-chat-context]
  Hydrate -->|shouldProceed| Intent[prepare-intent-input]
  Intent --> Short[prepare-short-lookup-answer]
  Short -->|skipAgent false| Analyse[analyse-intent classifier]
  Analyse --> Normalise[normalise-decision]

  Normalise -->|answer now| ReloadReply[reload-chat-thread-before-reply]
  Normalise -->|agent answer needed| Agent[dispatch-agent]
  Agent --> AgentDecision[normalise-agent-work-decision]

  Normalise -->|document discussion| DocDiscussion[document-discussion child]
  AgentDecision --> RouteDiscussion[route-discussion-chat]
  RouteDiscussion --> DocDiscussion

  Normalise -->|task routing pending| TaskInput[prepare-task-pipeline-input]
  TaskInput --> SelectTaskPipeline[select-task-pipeline classifier]
  SelectTaskPipeline --> NormaliseSelection[normalise-task-pipeline-selection]
  NormaliseSelection --> CreateTask[create-in-progress-task]
  CreateTask -->|selected child| StartSelected[start-selected-pipeline]
  CreateTask -->|multiple requirements| StartRequired[start-required-pipelines]

  AgentDecision -->|direct child, no task| StartDirect[start-direct-pipeline]

  StartSelected --> ReloadReply
  StartRequired --> ReloadReply
  StartDirect --> ReloadReply
  DocDiscussion --> ReloadReply
  ReloadReply --> Activity[mark-response-drafting]
  Activity --> PrepareResponse[prepare-chat-response]
  PrepareResponse --> PublishChat[publish-chat-response]
  PublishChat --> UserChat[User sees chat reply in same thread]
```

Chat dispatch can produce three broad outcomes:

- Direct chat answer: uses the hydrated thread and publishes through `dispatch.publishFlightDeckResponse`.
- Task-backed work: creates or reuses a task, passes `workPlan.taskId`, `origin.kind = "chat_thread"`, and `reporting.mode = "flightdeck_task"` to the child pipeline, then replies in chat with the task/child status.
- Direct child pipeline: passes thread origin and `reporting.mode = "chat_thread"` so the child returns to the original chat thread.

## Task Invocation

```mermaid
flowchart TD
  Invocation[Task invocation event] --> LoadTask[prepare-task-invocation-context]
  LoadTask --> Classify[classify-task-invocation agent]
  Classify --> Plan[normalise-task-invocation-plan]
  Plan -->|action direct_response| Comment[publish-task-invocation-response]
  Plan -->|action needs_input| Comment
  Plan -->|action ignore| Skip[no user response]
  Plan -->|action start_pipeline| Child[start-task-child-pipeline]
  Child --> Comment
  Comment --> UserTask[User sees task comment on invoked task]

  Child --> Software[software-implementation-review-loop]
  Child --> Research[research-and-report]
  Child --> DoReview[do-and-review]
```

Task invocation child work must receive:

| Field | Purpose |
| --- | --- |
| `workPlan.taskId` | Keeps the invoked task as the reporting surface |
| `workPlan.instructions` | Full agent instruction derived from invocation prompt and task context |
| `workPlan.originalPrompt` | Exact user invocation prompt |
| `workPlan.origin.kind = "flightdeck_task"` | Distinguishes task invocation from chat-origin work |
| `workPlan.origin.taskId` | Lets closeout and comments target the same task |
| `workPlan.reporting.mode = "flightdeck_task"` | Enables deterministic task comments/state closeout |
| `workPlan.workdir` and `workPlan.targetSurface` | Required for software implementation work |

## Document Invocation

```mermaid
flowchart TD
  DocInvocation[Document invocation event] --> LoadDoc[prepare-document-invocation-context]
  LoadDoc --> Agent[handle-document-invocation agent]
  Agent --> Publish[publish-document-invocation-summary]
  Publish --> UserChannel[User sees channel message with document mention and summary]
  Agent --> Doc[Agent may edit document or create document comments with Flight Deck document tools]
```

Document invocation passes the agent:

- Target document id, title, mention, body snapshot, comments, and local snapshot path.
- Exact invocation prompt.
- Workspace, channel, and scope context.
- Guidance that edits/comments should happen on the document and the summary should be posted back to the channel.

## Task Response Dispatch

```mermaid
flowchart TD
  TaskEvent[Task assignment/update event] --> Agent[investigate-and-route-task agent]
  Agent --> WorkPlan[normalise-work-plan]
  WorkPlan --> InProgress[move-task-to-in-progress]
  InProgress --> Child[start-follow-up-pipeline]
  Child --> Update[publish-task-update]
  Update --> UserTask[User sees task comment and task state]

  Child --> Software[software-implementation-review-loop]
  Child --> Research[research-and-report]
  Child --> DoReview[do-and-review]
```

This path is for classic task dispatch, not task invocation. It expects an existing task record and lets the agent decide whether to launch a child pipeline. The deterministic publisher reports through the task.

## Comment Response Dispatch

```mermaid
flowchart TD
  TaggedComment[Tagged task or document comment] --> Draft[draft-comment-response agent]
  Draft --> Publish[publish-comment-reply]
  Publish --> UserComment[User sees reply on the same task/document comment surface]
```

The comment response path should receive the target record id and target type. `dispatch.publishFlightDeckResponse` uses that binding to reply on the correct task or document comment surface.

## Child Work Pipelines

```mermaid
flowchart TD
  Start[Child pipeline start] --> Reporting{reporting.mode}

  Reporting -->|flightdeck_task| TaskBacked[Task-backed closeout]
  Reporting -->|chat_thread| ChatBacked[Chat-thread closeout]
  Reporting -->|missing/direct| Direct[No Flight Deck closeout unless pipeline defines one]

  TaskBacked --> Work[Worker/research/do agent work]
  ChatBacked --> Work
  Direct --> Work

  Work --> Review[Manager/review pass]
  Review -->|more work| Work
  Review -->|done| Final[Final report agent]

  Final -->|flightdeck_task| TaskClose[markTaskReadyForReview and task comment]
  Final -->|chat_thread| ChatClose[publishFlightDeckResponse to original thread]
```

### `software-implementation-review-loop`

Required inputs:

- `workPlan.taskId` when task-backed.
- `workPlan.instructions` / `implementationPrompt`.
- `workPlan.workdir`.
- `workPlan.targetSurface`.
- Optional `designDocumentUrl`, `visualReferences`, `acceptanceCriteria`, and `maxReviewIterations`.

Return behavior:

- `reporting.mode = "flightdeck_task"`: comments progress on the task, moves task to `review` only when manager review is done.
- `reporting.mode = "chat_thread"`: drafts and publishes a final chat-thread response.

### `do-and-review`

Required inputs:

- `workPlan.taskSummary`.
- `workPlan.instructions`.
- Optional `workPlan.taskId`, `workPlan.reporting`, and origin fields.

Return behavior:

- If task-backed, reloads context, drafts final response, and moves the task to review.
- Without task-backed reporting, it runs as direct agent work and returns pipeline output only.

### `research-and-report`

Required inputs:

- `workPlan.taskSummary`.
- `workPlan.instructions` / research question.
- Optional sources, constraints, `taskId`, and reporting context.

Return behavior:

- If task-backed, writes final response to the task and moves it to review.
- Without task-backed reporting, it returns report data in the pipeline output.

## Utility Pipelines

```mermaid
flowchart LR
  DesignReview[design-review] --> ReviewOutput[structured critique and final review output]
  Daily[daily-note-review] --> DailyOutput[progress evaluation from Tower PG daily context]
```

These are seeded pipelines but are not default Flight Deck dispatch targets.

## Main Gaps To Watch

- `fd-agent-dispatch-task-response` is still the legacy default for ordinary task assignment/update dispatch. `fd-task-invocation` is now the default only for explicit task invocation events.
- Direct child-pipeline launches without `reporting.mode` have no guaranteed user-visible closeout. They should be treated as pipeline output unless the launcher sets a reporting target.
- Software work needs a concrete `workdir` and `targetSurface`; otherwise the dispatch path should ask for input instead of guessing.
- Restart is required after code changes before the live Autopilot process can use newly wired dispatch functions.
