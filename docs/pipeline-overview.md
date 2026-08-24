# Flight Deck Dispatch Pipeline Overview

This document maps the Flight Deck Dispatch paths that are currently configured for chat, task, and comment advisories.

## Runtime Gate

Every Flight Deck advisory passes through `DispatchPipelineRuntime` before a declarative pipeline starts.

1. The runtime loads routes for the subscription, trigger kind, and capability.
2. It adds a profile-policy route when an agent profile has a pipeline override and either no stored route exists or the override is not only the built-in default.
3. If no route exists and pipeline routes are required, the advisory is suppressed as `pipeline_route_required`. If routes are not required, dispatch is left unhandled.
4. Disabled routes are suppressed as `route_disabled`.
5. Enabled routes must match their route `matchJson`:
   - `groupNpubs` must include one of the event groups unless it includes `*`.
   - `taskStates` or `recordStates` must include the current record state when configured.
   - `assignedTo: "bot"` requires the record to be assigned to the subscription bot.
   - Any explicit `assignedTo` npub must match the record assignment.
   - `changedFields` must intersect the advisory changed fields when configured.
6. Chat advisories authored by the bot, workspace key, or selected agent bot are suppressed as `self_authored`.
7. The runtime builds a dedupe key from subscription, workspace, source app, record id, record version, binding id, and route id.
8. The route concurrency key is rendered from the route template. Defaults:
   - Chat: `${workspace.subscriptionId}:${routing.threadId}:${route.routeId}`
   - Task/comment: `${workspace.subscriptionId}:${record.recordId}:${route.routeId}`
9. In-flight duplicate starts are suppressed as `dedupe_in_flight`.
10. If `activePolicy` is `skip`, a matching running pipeline with the same concurrency key suppresses the new advisory as `active_run`.
11. If `dedupeWindowSeconds` is positive, a recent run with the same dedupe key suppresses the advisory as `dedupe_window`.
12. The selected pipeline definition is loaded. If it is missing, the runtime falls back by trigger/capability:
   - `chat` + `chat_intercept`: `agent-dispatch-chat`
   - `task` + `task_dispatch`: `agent-dispatch-task-response`
   - `comment` + `comment_dispatch`: `agent-dispatch-comment-response`
13. Runtime functions are injected for Flight Deck publishing, chat hydration, task state updates, task creation, needs-input publishing, and child pipeline starts.
14. The dispatch envelope is passed into the pipeline with `dispatch`, `workspace`, `agent`, `record`, `chat` for chat triggers, `routing`, `runtime`, and optional profile runtime context.

## Current Route Set

The current local route table has four subscriptions with the same three trigger families:

| Trigger | Capability | Pipeline | Active policy | Concurrency |
| --- | --- | --- | --- | --- |
| `chat` | `chat_intercept` | `fd-agent-dispatch-chat` for three subscriptions, `workspace-agent-agent-dispatch-chat` for one subscription | `queue` | subscription + thread + route |
| `task` | `task_dispatch` | `fd-agent-dispatch-task-response` for three subscriptions, `agent-dispatch-task-response` for one subscription | `skip` | subscription + record + route |
| `comment` | `comment_dispatch` | `fd-agent-dispatch-comment-response` for three subscriptions, `agent-dispatch-comment-response` for one subscription | `skip` | subscription + record + route |

<comment>task and comment dispatch should be activated.</comment>

All current stored route `matchJson` values are `{}`, so trigger, capability, route enabled state, self-authorship, active policy, and dedupe are the effective routing controls.

<comment>Explain what this empty matchJson means in the chat, what is the example where would this be used?</comment>

The `fd-*` pipelines are Flight Deck PG workspace-first variants. The older `agent-dispatch-*` definitions are still valid fallbacks and are used by one configured subscription for task and comment dispatch. Their high-level flow is the same.

<comment>Remove fallbacks and delete the pipelines, it gets too complicated and its never clear if the desired behaivour is actually working.</comment>

## Chat Dispatch

Primary definitions:

- `fd-agent-dispatch-chat`
- `agent-dispatch-chat`
- `workspace-agent-agent-dispatch-chat` for one user-specific route

### Main Flow

1. `hydrate-chat-context` calls `dispatch.hydrateChatContext`.
   - PG workspaces load the source thread through Flight Deck PG.
   - Yoke workspaces run `chat context`; on failure they sync and retry; on another failure they build fallback context from the triggering message. <comment>Remove this step we are turning of yoke / encrypted records. Does this step send the emoji response? I would like the thumbs up on receipt to be very quick</comment>
   - The step also acknowledges the source message, records hydration warnings, lists referenced records, and marks `shouldProceed: false` for self-authored chat.
2. If `chatContext.shouldProceed` is not `true`, all later chat steps are skipped and no reply is published.
3. `prepare-intent-input` compacts the latest thread, referenced records, scopes, and up to eight valid child pipelines for the intent agent. <comment>I feel like we get some blow out in the initial prompt here by including all pipelines, perhaps we can have a step later that loads pipelines as a single step and agent acction if it decides it needs to route work.</comment>
4. `analyse-intent` asks the default agent to classify the request:
   - direct chat response
   - clarification needed
   - no-task discussion
   - task-backed work
   - ignore
   - <comment>What are the differences etween task-backed work and no task discussion vs. direct chat response?</comment>
5. `normalise-decision` converts the agent output into deterministic routing fields:
   - `intent: "ignore"` suppresses all response and work.
   - `dispatchTask` only remains true when the agent explicitly requested task-backed work, the selected pipeline is not a dispatch pipeline, a workdir exists, instructions exist, and no clarifying question is present.
   - Missing pipeline, workdir, or instructions turns the result into a clarification/direct chat response instead of work dispatch.
   - Discussion pipelines are never treated as task-backed work.
6. The shared `fd-agent-dispatch-chat` and `agent-dispatch-chat` definitions run `detect-review-approval`.
   - If the latest chat text is not approval-like, nothing happens.
   - If approval text is present and exactly one linked task is in review, `complete-review-task-from-chat` marks it done and comments on the task.
   - If approval text is ambiguous or no review task is linked, the final response asks for the missing target. <comment>THIS STEP FEELS LIKE AN OLD CONCPET THATS NOT NEEDED ANYMORE</comment>
7. `route-discussion-chat` may turn the decision into a no-task child pipeline.
   - It preserves simple direct replies when the agent supplied a direct chat answer and did not request a pipeline.
   - It launches discussion when the selected pipeline is a discussion/document discussion pipeline, the intent reads as discussion/planning/design thinking, or the latest text looks document-discussion related.
   - It sets `dispatchDiscussion: true`, keeps `dispatchTask: false`, and creates a discussion work plan. <comment>what is a discussion workplan</comment>
   - In `workspace-agent-agent-dispatch-chat`, this step uses the user function `discussion.chatRouting` instead of the shared `dispatch.routeDiscussionChat`.
8. If `decision.dispatchDiscussion` is true, `start-discussion-pipeline` starts the selected no-task child pipeline and stores it as `childPipeline`.
9. If `decision.dispatchTask` is true, `create-in-progress-task` creates a Flight Deck task in `in_progress`, assigned to the bot, with source-message metadata.
10. If `decision.dispatchTask` is true, `start-selected-pipeline` starts the selected child pipeline using the created task work plan.
11. If the child pipeline failed to start, `block-task-on-launch-failure` moves the created task to `blocked` and comments with the launch failure.
12. Shared chat definitions reload the thread before replying. The `workspace-agent` override skips that closeout reload.
13. `prepare-chat-response` decides the final chat response:
   -<comment>task management actions dont really belong in this workflow APPROVAL records are not in PG Flight DEck, it didnt work too abstract keep this pipeline to chat, tasks. we can always route to task workflows if there is a task referenced in the thread.</comment>
   - Review approval success: "marked task complete" response.
   - Review approval ambiguous: asks which task to mark done.
   - Suppressed/ignored decision: no response.
   - Task creation failed: explains the failure and asks for retry/checking dispatch connectivity.
   - Task-backed child pipeline started: mentions the created task and pipeline run.
   - Child pipeline needs input: includes the question unless it was already posted by needs-input publishing.
   - Child pipeline launch failed: says the task was blocked.
   - Direct chat or no-task discussion: uses the prepared draft.
14. `publish-chat-response` posts the response to the source Flight Deck thread unless `shouldRespond` is false.

### Chat Branch Summary

| Cause | Result |
| --- | --- |
| Route missing, disabled, unmatched, self-authored, active duplicate, or recent duplicate | Suppressed before pipeline start |
| Hydration identifies self-authored dispatch | Pipeline skips all downstream chat work |
| Agent intent is `ignore` | No task, no child pipeline, no reply |
| Agent gives a simple direct reply | Reply in chat only |
| Agent asks a clarifying question or required task fields are missing | Reply with clarification; no task |
| Latest message approves exactly one linked review task | Mark review task done; reply with completion |
| Approval text has zero or multiple linked review tasks | Ask which review task to complete |
| Discussion/document discussion intent | Start no-task discussion child pipeline; reply in chat |
| Valid task-backed request | Create task, start selected child pipeline, reply in chat |
| Task creation fails | Reply with failure; no child pipeline |
| Child pipeline start fails after task creation | Block task and reply with failure |
| Child pipeline returns `needs_input` | Publish needs-input question, then suppress duplicate chat reply if already notified |

## Task Dispatch

Primary definitions:

- `fd-agent-dispatch-task-response`
- `agent-dispatch-task-response`

Task dispatch is for a Flight Deck task advisory, usually a task assigned to the bot. The current stored routes have no state or assignment filter, but route matching supports those filters if configured.

### Main Flow

1. `investigate-and-route-task` asks the default agent to inspect the task payload and choose a work style.
2. `normalise-work-plan` converts the agent response into a deterministic work plan.
   - If the response explicitly requests `do_and_review` or generic work, it chooses `do-and-review`.
   - If the response or task text contains software/code/repo/test/build/deploy/UI/server/database terms, it chooses `software-implementation-review-loop`.
   - Otherwise it defaults to `do-and-review`.
   - For software implementation, it tries to resolve a design document reference from the task context.
   - It fills default execution plan, manager checklist, task update plan, workdir, and confidence when the agent omitted them.
3. `move-task-to-in-progress` moves the source task to `in_progress`.
4. `start-follow-up-pipeline` starts the chosen child pipeline with the normalized work plan.
5. `publish-task-update` updates/comments on the source task with the selected state and launched child pipeline summary.

### Task Branch Summary

| Cause | Result |
| --- | --- |
| Route active policy finds a running task run for the same record | Suppressed as `active_run` |
| Recent duplicate advisory in dedupe window | Suppressed as `dedupe_window` |
| Agent/task text looks software-related | Child pipeline is `software-implementation-review-loop` |
| Agent/task text is generic or explicitly asks generic work | Child pipeline is `do-and-review` |
| Child pipeline starts successfully | Task is moved/commented with launch/update details |
| Child pipeline returns `needs_input` | Runtime attempts to publish needs-input to the task/chat through dispatch runtime functions |
| Publishing task update fails | Pipeline records failed/partial publish status; the child run may still exist |

## Comment Dispatch

Primary definitions:

- `fd-agent-dispatch-comment-response`
- `agent-dispatch-comment-response`

Comment dispatch is intentionally small: it drafts and publishes a reply to a task or document comment thread.

### Main Flow

1. `draft-comment-response` asks the default agent to draft a comment reply from workspace, agent, record, and routing context.
2. `publish-comment-reply` calls `dispatch.publishFlightDeckResponse`.
   - If the comment targets a task, PG mode creates a task comment with `parent_comment_id`; Yoke mode runs `tasks reply`.
   - If the comment targets a document, Yoke mode runs `docs reply`.
   - PG document comment replies are not available yet, so PG document-comment dispatch returns a failed publish result.

### Comment Branch Summary

| Cause | Result |
| --- | --- |
| Route active policy finds a running comment run for the same record | Suppressed as `active_run` |
| Recent duplicate advisory in dedupe window | Suppressed as `dedupe_window` |
| Agent returns `replyDraft`, `responseDraft`, `body`, or `nextAction` | Reply is published |
| No reply body or no comment id | Publish step fails |
| PG task comment | Creates a child task comment |
| PG document comment | Fails with "Flight Deck PG document comment replies are not available yet" |
| Yoke task/document comment | Uses `tasks reply` or `docs reply` |

## Child Pipelines Started By Dispatch

### `software-implementation-review-loop`

Used for task-backed code, repo, build, test, deployment, UI, API, server, database, migration, or implementation work.

1. Ensure or create an implementation review task in progress.
2. Run an implementation worker in the selected working directory.
3. Run a managerial review against the design/task, repository state, diff, tests, and worker handoff.
4. Normalize manager review JSON.
5. Comment manager progress to the Flight Deck task.
6. If `managerReview.done` is false, loop back to the worker until `maxReviewIterations`.
7. Produce a final implementation report.
8. Reload the final thread.
9. Draft a final user-facing thread response.
10. Move the task to `review`.

The main branch is the manager loop: `managerReview.done === false` causes another worker pass until the loop limit is reached.

### `do-and-review`

Used for generic task-backed delivery such as research, planning, writing, operations, or miscellaneous non-code work.

1. Worker completes the requested work from `createdTask` and `workPlan`.
2. Manager reviews the worker result against the work plan and evidence.
3. Reload final thread context.
4. Draft a final user-facing thread response.
5. Move the task to `review`.

This pipeline does not loop. Missing information is handled as a best-effort partial result and final task/chat feedback rather than a hard `needs_input` callback.

### `document-discussion`

Used for no-task planning, design, document, and document-comment discussion.

1. Reload the source thread.
2. Load referenced document and comment context.
3. Reuse a referenced document or create a scaffold discussion document.
4. Update the document when the latest thread implies a useful change.
5. Review the document/update against the discussion goal.
6. Draft the next useful chat response or question.
7. Publish the reply to the source thread.

This path deliberately does not create a Flight Deck task.

### `discussion-chat-response`

Used by the `workspace-agent` discussion routing path for no-task planning/design discussion and graph-backed chat response.

1. Extract discussion entities from the latest thread.
2. Search Tower graph for relevant memory.
3. Decide whether durable discussion knowledge should be stored.
4. Import any graph patch.
5. Draft a discussion answer, optionally using bounded internet lookup when current external information would materially improve the answer.
6. Publish the reply to the source thread.

This path also deliberately does not create a Flight Deck task.