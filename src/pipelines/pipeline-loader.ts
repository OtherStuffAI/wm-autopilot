import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { DeclarativePipeline } from "./declarative";
import type { PipelineScope } from "./pipeline-store";

export interface PipelineDefinitionRecord {
  id: string;
  slug: string;
  name: string;
  scope: PipelineScope;
  ownerAlias: string | null;
  path: string;
  spec: DeclarativePipeline;
}

const CHAT_DISPATCH_CLASSIFIER_MODEL = "openai/gpt-oss-120b:nitro";

const AGENT_DISPATCH_CHAT_DEFINITION = {
  name: "agent-dispatch-chat",
  description: "Default dispatch pipeline for chat advisories. Runtime acknowledgement happens before this pipeline; the pipeline hydrates Flight Deck PG chat context, classifies answer_now, think_then_answer, or create_task, and loads task-capable pipeline candidates only after durable task intent.",
  default: true,
  tags: ["default", "dispatch", "chat", "flight-deck"],
  input: {
    dispatch: { triggerKind: "chat" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "chat-message-demo",
      recordFamily: "chat",
      payload: {
        body: "Can you give me the current status and next action?",
        sender_npub: "npub1user",
      },
    },
    chat: {
      messageText: "Can you give me the current status and next action?",
      senderNpub: "npub1user",
      channelId: "channel-demo",
      threadId: "thread-demo",
    },
    routing: { channelId: "channel-demo", threadId: "thread-demo", bindingType: "thread" },
    flightDeckContext: {
      channel: {
        id: "channel-demo",
        scopeId: "scope-demo",
        name: "Demo Channel",
        contextPrompt: "No Specific Channel Context",
        hasSpecificContext: false,
      },
    },
  },
  steps: [
    {
      name: "prepare-workroom-participant-metadata",
      description: "Build typed participant metadata for a workroom self-fill before role-specific chat classification.",
      type: "code",
      function: "workroom.prepareParticipantMetadata",
      input: {
        pick: {
          workroomContext: "$.workroomContext",
          workspace: "$.workspace",
          agent: "$.agent",
          runtime: "$.runtime",
          persist: "$.runtime.persistParticipantMetadata",
        },
      },
      assign: "$.participantMetadata",
      display: {
        in: [{ label: "Workroom", path: "$.workroomContext.isWorkroom" }],
        out: [{ label: "Participant Metadata", path: "$.metadata", format: "text" }],
      },
    },
    {
      name: "hydrate-chat-context",
      description: "Fetch the latest Flight Deck PG thread, referenced records, and visible scopes after the runtime has already acknowledged receipt.",
      type: "code",
      function: "dispatch.hydrateChatContext",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          flightDeckContext: "$.flightDeckContext",
          workroomContext: "$.workroomContext",
        },
      },
      assign: "$.chatContext",
      display: {
        in: [
          { label: "Message", path: "$.chat.messageText", format: "text" },
        ],
        out: [
          { label: "Thread", path: "$.thread", format: "messages", limit: 6, empty: "No thread messages" },
          { label: "Channel Context", path: "$.channelContext.contextPrompt", format: "text" },
          { label: "Self Authored", path: "$.selfAuthored" },
          { label: "Referenced Records", path: "$.referencedRecords", format: "records", limit: 4, empty: "No referenced records" },
        ],
      },
    },
    {
      name: "prepare-intent-input",
      description: "Compact the hydrated chat context into the decision packet the intent agent needs, without passing duplicated runtime machinery.",
      type: "code",
      function: "dispatch.prepareChatIntentInput",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          flightDeckContext: "$.flightDeckContext",
          workroomContext: "$.workroomContext",
        },
      },
      assign: "$.chatDispatchInput",
      display: {
        in: [
          { label: "Thread", path: "$.chatContext.thread", format: "messages", limit: 6, empty: "No thread messages" },
        ],
        out: [
          { label: "Objective", path: "$.objective", format: "text" },
          { label: "Thread", path: "$.latestThread", format: "messages", limit: 6, empty: "No thread messages" },
          { label: "Channel Context", path: "$.channelContext.contextPrompt", format: "text" },
          { label: "Referenced Records", path: "$.referencedRecords", format: "records", limit: 4, empty: "No referenced records" },
        ],
      },
    },
    {
      name: "prepare-short-lookup-answer",
      description: "Answer trivial greetings and bounded workspace focus/status lookups without launching an agent or child task.",
      type: "code",
      function: "dispatch.prepareShortLookupAnswer",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          workspace: "$.workspace",
          chatDispatchInput: "$.chatDispatchInput",
        },
      },
      assign: "$.agentDecision",
      display: {
        in: [
          { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages", limit: 4, empty: "No thread messages" },
        ],
        out: [
          { label: "Fast Answer", path: "$.skipAgent" },
          { label: "Intent", path: "$.intent", format: "text" },
          { label: "Reply", path: "$.chatResponse.body", format: "text" },
        ],
      },
    },
    {
      name: "analyse-intent",
      description: "Fast gate: classify the chat request as answer_now, think_then_answer, or create_task without loading task pipeline candidates.",
      type: "classifier",
      when: { path: "$.agentDecision.skipAgent", equals: false },
      provider: "openrouter",
      model: CHAT_DISPATCH_CLASSIFIER_MODEL,
      retries: 3,
      timeoutMs: 8000,
      input: {
        pick: {
          chatDispatchInput: "$.chatDispatchInput",
        },
      },
      prompt: "You are stage 1 of agent-dispatch-chat: Fast Gate. The selected input contains chatDispatchInput, a compact decision packet. Use chatDispatchInput.latestThread as the authoritative latest conversation, chatDispatchInput.channelContext.contextPrompt as channel-specific instructions, and referencedRecords as supporting context. When chatDispatchInput.workroomContext exists, treat it as typed authority: enforce its participant role, room goal/state, repo and branches, app targets/runbooks, recent events/links, and approvals. Integration coordinates; contributor scopes and validates work; reviewer writes evidence; approver decides approvals without implementing; observer answers only when directly asked or mentioned. Do not choose child pipelines. Do not inspect repositories, sessions, files, Flight Deck state, Tower state, or external sources in this stage. Classify only as answer_now, think_then_answer, create_task, or ignore. Use answer_now only when the complete final reply can be written immediately from supplied context in chatResponse.body. Use think_then_answer when the final output is still a chat answer but needs reasoning, context loading, lookup, or multiple internal steps. Use create_task only when the user needs durable output such as code, docs, files, WApp changes, migrations, configuration, or other concrete artifacts. Use ignore for self-authored or non-actionable dispatches. For create_task, include taskDraft with title, instructions, acceptanceCriteria, executionPlan, and managerChecklist when enough information is available; ask one clarifyingQuestion when required information is missing. Return JSON only with: intent string exactly answer_now|think_then_answer|create_task|ignore, chatResponse object with body string|null, clarifyingQuestion string|null, taskDraft object|null, confidence number from 0 to 1.",
      assign: "$.agentDecision",
      display: {
        in: [
          { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages", limit: 6, empty: "No thread messages" },
          { label: "Channel Context", path: "$.chatDispatchInput.channelContext.contextPrompt", format: "text" },
        ],
        out: [
          { label: "Intent", path: "$.intent", format: "text" },
          { label: "Reply", path: "$.chatResponse.body", format: "text" },
        ],
      },
    },
    {
      name: "normalise-decision",
      description: "Normalise the agent's intent JSON into the dispatch decision and child work plan.",
      type: "code",
      function: "dispatch.normaliseChatDispatchDecision",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          agentDecision: "$.agentDecision",
          flightDeckContext: "$.flightDeckContext",
        },
      },
      assign: "$.decision",
      display: {
        in: [
          { label: "Intent", path: "$.agentDecision.intent", format: "text" },
          { label: "Requested Pipeline", path: "$.agentDecision.recommendedPipelineId", format: "text" },
        ],
        out: [
          { label: "Dispatch Task", path: "$.dispatchTask" },
          { label: "Pipeline", path: "$.pipelineDefinitionId", format: "text" },
          { label: "Task", path: "$.workPlan.taskSummary", format: "text" },
          { label: "Reply", path: "$.responseDraft", format: "text" },
          { label: "Clarifying Question", path: "$.clarifyingQuestion", format: "text" },
        ],
      },
    },
    {
      name: "dispatch-agent",
      description: "Run chat-only thinking for requests whose final output should still be a thread reply.",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      timeoutMs: 600000,
      when: { path: "$.decision.dispatchAgent", equals: true },
      input: {
        pick: {
          latestThread: "$.chatDispatchInput.latestThread",
          channelContext: "$.chatDispatchInput.channelContext",
          referencedRecords: "$.chatDispatchInput.referencedRecords",
          scopes: "$.chatDispatchInput.scopes",
          workspaceId: "$.workspace.workspaceId",
          workspaceOwnerNpub: "$.workspace.workspaceOwnerNpub",
          humanWorkspaceOwnerNpub: "$.workspace.humanWorkspaceOwnerNpub",
          sourceAppNpub: "$.workspace.sourceAppNpub",
          channelId: "$.chatDispatchInput.source.channelId",
          threadId: "$.chatDispatchInput.source.threadId",
          messageId: "$.chatDispatchInput.source.messageId",
          requesterNpub: "$.chatDispatchInput.source.requesterNpub",
          agentWorkingDirectory: "$.agent.workingDirectory",
          defaultAgent: "$.agent.defaultAgent",
          decision: "$.decision",
        },
      },
      prompt: "You are the Wingman chat thinking agent. The fast classifier decided this thread needs thinking, but the final output should still be a chat reply unless you discover the user actually needs durable output. Read the selected input carefully, using latestThread as the latest user-visible thread and channelContext.contextPrompt as high-information channel/project policy, not generic decoration. Inspect bounded current Autopilot/Flight Deck/Tower/session state, local project directories, repo files, docs, or external sources only when needed to answer the chat. Keep the work chat-first: answer in chat after inspection, or ask one focused clarifying question. Do not choose child pipelines in this step. Do not create tasks for discussion, planning, explanations, summaries, opinions, recommendations, operational status checks, or research that only needs a chat answer. If you discover the user needs durable output such as code, docs, files, WApp changes, migrations, configuration, or other concrete artifacts, return action start_pipeline with createTask true and a taskDraft/workPlan describing the durable work, but leave pipeline selection to the later task routing step. Return JSON only with: action reply|clarify|start_pipeline|ignore, chatResponse {body:string|null}, clarifyingQuestion string|null, createTask boolean, taskDraft object|null, workPlan object|null, confidence number.",
      assign: "$.agentWorkDecision",
      display: {
        in: [
          { label: "Thread", path: "$.chatDispatchInput.latestThread", format: "messages", limit: 6, empty: "No thread messages" },
        ],
        out: [
          { label: "Action", path: "$.action", format: "text" },
          { label: "Pipeline", path: "$.recommendedPipelineId", format: "text" },
          { label: "Reply", path: "$.chatResponse.body", format: "text" },
          { label: "Clarifying Question", path: "$.clarifyingQuestion", format: "text" },
        ],
      },
    },
    {
      name: "normalise-agent-work-decision",
      description: "Turn the dispatch agent's decision into deterministic reply, clarification, task creation, or child pipeline launch state.",
      type: "code",
      function: "dispatch.normaliseChatAgentWorkDecision",
      when: { path: "$.decision.dispatchAgent", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          chatDispatchInput: "$.chatDispatchInput",
          decision: "$.decision",
          agentWorkDecision: "$.agentWorkDecision",
          flightDeckContext: "$.flightDeckContext",
        },
      },
      assign: "$.decision",
    },
    {
      name: "route-discussion-chat",
      description: "Turn document/design/planning chat into a no-task discussion child pipeline when channel context calls for document iteration.",
      type: "code",
      function: "dispatch.routeDiscussionChat",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          chatDispatchInput: "$.chatDispatchInput",
          agentDecision: "$.agentDecision",
          decision: "$.decision",
          flightDeckContext: "$.flightDeckContext",
        },
      },
      assign: "$.decision",
    },
    {
      name: "prepare-task-pipeline-input",
      description: "Load compact task-capable pipeline candidates only after create_task intent has been established.",
      type: "code",
      function: "dispatch.prepareChatTaskPipelineInput",
      when: { path: "$.decision.taskRoutingPending", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          decision: "$.decision",
          flightDeckContext: "$.flightDeckContext",
        },
      },
      assign: "$.taskPipelineInput",
    },
    {
      name: "select-task-pipeline",
      description: "Choose the task-capable workflow for durable chat output after the initial intent classifier has selected create_task.",
      type: "classifier",
      when: { path: "$.decision.taskRoutingPending", equals: true },
      provider: "openrouter",
      model: CHAT_DISPATCH_CLASSIFIER_MODEL,
      retries: 3,
      timeoutMs: 12000,
      input: {
        pick: {
          taskPipelineInput: "$.taskPipelineInput",
        },
      },
      prompt: "You are the task workflow selector for Flight Deck chat dispatch. The initial chat classifier has already decided this request needs durable task output. Choose exactly one task-capable pipeline from taskPipelineInput.validChildPipelines. Do not choose agent-dispatch, fd-agent-dispatch, intake, discussion, document-discussion, or chat-only pipelines. Use software-implementation-review-loop for code, repository, build, test, deployment, migration, backend, frontend, API, database, or system implementation work. Use research-and-report for durable research deliverables. Use do-and-review for generic durable work when no specialised task pipeline fits. If software-implementation-review-loop is selected, include concrete workdir and targetSurface when they are known; ask one clarifyingQuestion if they are missing. Return JSON only with: recommendedPipelineId string, workdir string|null, scopeId string|null, targetSurface object|null, visualReferences array|null, clarifyingQuestion string|null, chatResponse {body:string|null}, confidence number.",
      assign: "$.taskPipelineDecision",
      display: {
        in: [
          { label: "Task", path: "$.taskPipelineInput.taskDraft.title", format: "text" },
          { label: "Pipelines", path: "$.taskPipelineInput.validChildPipelines", format: "records", limit: 8, empty: "No task-capable pipelines" },
        ],
        out: [
          { label: "Pipeline", path: "$.recommendedPipelineId", format: "text" },
          { label: "Workdir", path: "$.workdir", format: "text" },
          { label: "Clarifying Question", path: "$.clarifyingQuestion", format: "text" },
        ],
      },
    },
    {
      name: "normalise-task-pipeline-selection",
      description: "Validate the selected task workflow and enable task creation only when the durable work contract is complete.",
      type: "code",
      function: "dispatch.normaliseChatTaskPipelineSelection",
      when: { path: "$.decision.taskRoutingPending", equals: true },
      input: {
        pick: {
          decision: "$.decision",
          taskPipelineInput: "$.taskPipelineInput",
          taskPipelineDecision: "$.taskPipelineDecision",
        },
      },
      assign: "$.decision",
    },
    {
      name: "create-in-progress-task",
      type: "code",
      function: "dispatch.createChatTask",
      when: { path: "$.decision.dispatchTask", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          decision: "$.decision",
          chatContext: "$.chatContext",
        },
      },
      assign: "$.createdTask",
    },
    {
      name: "start-selected-pipeline",
      type: "code",
      function: "dispatch.startChildPipeline",
      when: { path: "$.decision.dispatchSingleTaskPipeline", equals: true },
      input: {
        pick: {
          pipelineDefinitionId: "$.createdTask.pipelineDefinitionId",
          workPlan: "$.createdTask.workPlan",
          childInput: "$",
        },
      },
      assign: "$.childPipeline",
    },
    {
      name: "start-required-pipelines",
      type: "code",
      function: "dispatch.startChildPipelines",
      when: { path: "$.decision.pipelinesRequired", equals: true },
      input: {
        pick: {
          pipelines: "$.decision.pipelineLaunches",
          childInput: "$",
          createdTask: "$.createdTask",
        },
      },
      assign: "$.childPipelines",
    },
    {
      name: "start-direct-pipeline",
      type: "code",
      function: "dispatch.startChildPipeline",
      when: { path: "$.decision.dispatchSingleDirectPipeline", equals: true },
      input: {
        pick: {
          pipelineDefinitionId: "$.decision.pipelineDefinitionId",
          workPlan: "$.decision.workPlan",
          childInput: "$",
        },
      },
      assign: "$.childPipeline",
    },
    {
      name: "reload-chat-thread-before-reply",
      type: "code",
      function: "dispatch.reloadChatThread",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          chat: "$.chat",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          chatContext: "$.chatContext",
          flightDeckContext: "$.flightDeckContext",
        },
      },
      assign: "$.closeoutContext",
    },
    {
      name: "mark-response-drafting",
      description: "Tell Flight Deck that the agent is drafting the reply that will be posted to the thread.",
      type: "code",
      function: "dispatch.setResponseActivity",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: { value: {
        status: "drafting",
        label: "Writing a reply",
        expiresInSeconds: 90,
      } },
      assign: "$.responseActivity",
    },
    {
      name: "prepare-chat-response",
      type: "code",
      function: "dispatch.prepareChatDispatchResponse",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          decision: "$.decision",
          createdTask: "$.createdTask",
          childPipeline: "$.childPipeline",
          childPipelines: "$.childPipelines",
          closeoutContext: "$.closeoutContext",
        },
      },
      assign: "$.agentResponse",
    },
    {
      name: "publish-chat-response",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      when: { path: "$.chatContext.shouldProceed", equals: true },
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.agentResponse",
        },
      },
    },
  ],
};

const AGENT_DISPATCH_TASK_DEFINITION = {
  name: "agent-dispatch-task-response",
  description: "Task intake delegator. It investigates the task, chooses software-implementation-review-loop, research-and-report, or do-and-review, starts the child pipeline, then comments back with the launched work plan.",
  default: true,
  tags: ["default", "dispatch", "task", "intake", "flight-deck"],
  input: {
    dispatch: { triggerKind: "task" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "task-demo",
      recordFamily: "task",
      recordState: "ready",
      payload: {
        task_id: "task-demo",
        title: "Implement a small UI fix",
        description: "Review the request, make the smallest viable change, test it, and report back.",
        state: "ready",
        assigned_to: "npub1bot",
      },
    },
    routing: { bindingId: "task-demo", bindingType: "task", changedFields: ["state"] },
    flightDeckContext: {
      channel: {
        id: "channel-demo",
        scopeId: "scope-demo",
        name: "Demo Channel",
        contextPrompt: "No Specific Channel Context",
        hasSpecificContext: false,
      },
    },
  },
  steps: [
    {
      name: "investigate-and-route-task",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          workspaceId: "$.workspace.workspaceId",
          workspaceOwnerNpub: "$.workspace.workspaceOwnerNpub",
          sourceAppNpub: "$.workspace.sourceAppNpub",
          taskId: "$.record.payload.task_id",
          taskTitle: "$.record.payload.title",
          taskDescription: "$.record.payload.description",
          taskState: "$.record.payload.state",
          assignedTo: "$.record.payload.assigned_to",
          bindingId: "$.routing.bindingId",
          bindingType: "$.routing.bindingType",
          changedFields: "$.routing.changedFields",
          channelContext: "$.flightDeckContext.channel",
        },
      },
      prompt: "You are stage 1 of a Wingman task intake delegator. Do an initial investigation from the selected task fields and channelContext.contextPrompt, then choose the origin-agnostic child work pipeline. Treat channelContext.contextPrompt as channel-specific instructions for how this task should be handled. Choose workStyle as software_implementation for repo/code/build/test/deployment work, research_and_report for durable research that should produce a cited report or document, or do_and_review for generic operational, planning, writing, or artifact work. Do not choose dispatch, chat, comment, intake, or document-discussion pipelines. For software_implementation, return a concrete workdir and targetSurface; use the repo named explicitly in channelContext.contextPrompt when present, and if no real repo/surface can be identified, leave workdir or targetSurface empty so the deterministic normalizer blocks launch instead of guessing. Return JSON fields: accepted boolean, workStyle string, taskSummary string, workdir string|null, targetSurface object|null, initialFindings array, executionPlan array, managerChecklist array, taskUpdatePlan array, risks array, confidence number from 0 to 1. The executionPlan must explicitly say when the child worker and manager should update the Flight Deck task.",
      assign: "$.agentResponse",
      display: {
        in: [
          { label: "Task", path: "$.record.payload.title", format: "text" },
          { label: "Channel Context", path: "$.flightDeckContext.channel.contextPrompt", format: "text" },
        ],
        out: [
          { label: "Accepted", path: "$.accepted" },
          { label: "Work Style", path: "$.workStyle", format: "text" },
          { label: "Summary", path: "$.taskSummary", format: "text" },
        ],
      },
    },
    {
      name: "normalise-work-plan",
      type: "code",
      function: "dispatch.normaliseTaskWorkPlan",
      input: {
        pick: {
          agentResponse: "$.agentResponse",
          record: "$.record",
          routing: "$.routing",
          agent: "$.agent",
          flightDeckContext: "$.flightDeckContext",
        },
      },
      assign: "$.workPlan",
    },
    {
      name: "move-task-to-in-progress",
      description: "Persist the Ready -> In progress transition before any child work is dispatched.",
      type: "code",
      function: "dispatch.markTaskInProgress",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          workPlan: "$.workPlan",
        },
      },
      assign: "$.taskStartUpdate",
    },
    {
      name: "start-follow-up-pipeline",
      type: "code",
      function: "dispatch.startChildPipeline",
      when: { path: "$.workPlan.launchable", equals: true },
      input: {
        pick: {
          pipelineDefinitionId: "$.workPlan.childPipelineDefinitionId",
          workPlan: "$.workPlan",
          childInput: "$",
        },
      },
      assign: "$.childPipeline",
    },
    {
      name: "publish-task-update",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.workPlan",
          childPipeline: "$.childPipeline",
        },
      },
    },
  ],
};

const FINAL_THREAD_RESPONSE_PROMPT = `You are the final response agent for a Wingman pipeline.

Your job is to write the message that will be posted back into the originating Flight Deck thread. Review the original thread, any refreshed thread context, the task/work plan, new worker output, manager review, and any artifacts created by the pipeline.

Rules:
- Be conversational. Write as a direct reply in the thread, not as pipeline telemetry.
- Be complete. Answer the user's actual question/request using the work that was just completed.
- If there is a Flight Deck document, WApp, file, or other user-accessible artifact, include the mention/link. Do not make the requester hunt through internal task records.
- Do not make an internal task the main artifact unless it is the only durable place the result exists.
- Do not say only that work is "ready for review"; summarise or present the useful output.
- Do not prefix the body with labels like "Summary:", "Task:", "Assigned back to:", or "Pipeline handoff:".
- If the work is incomplete or assumptions matter, say that plainly.
- If a follow-up question would materially improve the outcome, ask one focused question. If there is an obvious next step, suggest it.

Return JSON only:
{
  "body": "the exact chat reply to post",
  "summary": "short internal summary",
  "artifacts": [{"type":"document|wapp|file|task|other", "label":"", "mentionOrUrl":""}],
  "followUpQuestion": "question or null",
  "confidence": 0.0
}`;

const DO_AND_REVIEW_DEFINITION = {
  "name": "do-and-review",
  "description": "Origin-agnostic generic delivery pipeline. A worker completes non-code work such as research, planning, writing, or operations, then a manager reviews evidence and the pipeline reports either to the originating Flight Deck task/thread or as a direct pipeline result.",
  "default": true,
  "tags": [
    "default",
    "generic",
    "delivery",
    "review",
    "origin-agnostic"
  ],
  "input": {
    "taskId": "task-demo",
    "scopeId": "scope-demo",
    "workdir": "/workspace",
    "assignerNpub": "npub1requester",
    "reviewerNpub": "npub1requester",
    "workPlan": {
      "taskSummary": "Complete the requested task.",
      "instructions": "Use the task and chat context to complete the requested non-code work.",
      "acceptanceCriteria": [
        "The requested outcome is complete",
        "Evidence or sources are recorded"
      ],
      "executionPlan": [
        "Investigate",
        "Do the work",
        "Review evidence",
        "Report result"
      ],
      "managerChecklist": [
        "Sources or evidence are recorded",
        "The answer matches the task",
        "Task status was updated"
      ]
    },
    "reporting": {
      "mode": "pipeline_result",
      "callbackPipelineId": "",
      "callbackRef": {}
    }
  },
  "steps": [
    {
      "name": "normalise-work-plan-context",
      "description": "Normalise direct, chat, and Flight Deck task origins into one work plan and reporting contract.",
      "type": "code",
      "function": "dispatch.normaliseWorkPlanContext",
      "input": {
        "pick": {
          "taskId": "$.taskId",
          "scopeId": "$.scopeId",
          "workdir": "$.workdir",
          "assignerNpub": "$.assignerNpub",
          "reviewerNpub": "$.reviewerNpub",
          "workPlan": "$.workPlan",
          "createdTask": "$.createdTask",
          "reporting": "$.reporting",
          "dispatch": "$.dispatch",
          "workspace": "$.workspace",
          "agent": "$.agent",
          "record": "$.record",
          "routing": "$.routing",
          "runtime": "$.runtime"
        }
      },
      "assign": "$.workContext"
    },
    {
      "name": "do-work",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 1800000,
      "input": {
        "pick": {
          "createdTask": "$.workContext.createdTask",
          "workPlan": "$.workContext.workPlan"
        }
      },
      "prompt": "You are the worker in a Wingman do-and-review pipeline. Use only the selected input: createdTask and workPlan. workPlan includes the task plan, originalPrompt, originThread, referencedRecords, instructions, acceptanceCriteria, executionPlan, managerChecklist, and reporting mode. For current-world facts, use internet research and record sources. Always make the best effort possible from the available context. If required information is missing, do not return callback status needs_input; return callback status ok with completed false, state what you could and could not complete, list blockers, and write a concrete taskUpdateComment or result note that asks for the missing information or states the limitation for the final feedback. Do not fabricate requirements. Do not run Flight Deck task update, task comment, chat reply, chat reply-current, or any command that changes task state, task comments, or chat messages. Do not run Yoke or sync a Yoke workspace for Flight Deck PG work. Document comment replies are allowed only when workPlan explicitly asks to answer or respond to existing document comments and a current Wingman/Autopilot Flight Deck helper is available for the document comment thread surface; include evidence that child comments were created with parent_comment_id set to the original comment ids. Updating the document body does not satisfy an answer-comments request unless workPlan explicitly asks for a document-body response section. Return JSON fields: completed boolean, summary string, sources array, evidence array, result string, blockers array, taskUpdateComment string, confidence number.",
      "assign": "$.workerResult"
    },
    {
      "name": "manager-review",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 1200000,
      "input": {
        "pick": {
          "taskId": "$.workContext.createdTask.taskId",
          "taskSummary": "$.workContext.workPlan.taskSummary",
          "instructions": "$.workContext.workPlan.instructions",
          "acceptanceCriteria": "$.workContext.workPlan.acceptanceCriteria",
          "executionPlan": "$.workContext.workPlan.executionPlan",
          "managerChecklist": "$.workContext.workPlan.managerChecklist",
          "originalPrompt": "$.workContext.workPlan.originalPrompt",
          "originThread": "$.workContext.workPlan.originThread",
          "referencedRecords": "$.workContext.workPlan.referencedRecords",
          "reporting": "$.workContext.workPlan.reporting",
          "workerCompleted": "$.workerResult.completed",
          "workerSummary": "$.workerResult.summary",
          "workerSources": "$.workerResult.sources",
          "workerEvidence": "$.workerResult.evidence",
          "workerOutput": "$.workerResult.result",
          "workerBlockers": "$.workerResult.blockers",
          "taskUpdateComment": "$.workerResult.taskUpdateComment"
        }
      },
      "prompt": "You are the manager reviewer in a Wingman do-and-review pipeline. Use only the selected input. Check the worker fields against instructions, acceptanceCriteria, executionPlan, managerChecklist, originalPrompt, originThread, referencedRecords, and reporting. Verify sources/evidence are sufficient and decide whether the work is complete. If instructions ask to answer or respond to Flight Deck document comments, require evidence that actual comment-thread replies were created with parent_comment_id pointing at the original comment ids; a document-body section alone is not sufficient unless instructions explicitly requested that instead. If workerCompleted is false because information is missing, review the best-effort result as a handoffable partial outcome: set accepted according to whether the worker honestly used available context, put missing information or limitations in requiredChanges/risks, and rely on taskUpdateComment for final feedback. For Flight Deck task runs, the deterministic pipeline closeout updates the task to review and assigns it to the requester. For direct runs, return the review as the pipeline result. Return JSON fields: accepted boolean, taskSummary string, reviewSummary string, executionPlan array, managerChecklist array, requiredChanges array, risks array, confidence number.",
      "assign": "$.agentResponse"
    },
    {
      "name": "reload-final-thread",
      "description": "Refresh the originating thread before composing the final user-facing response.",
      "type": "code",
      "function": "dispatch.reloadChatThread",
      "input": {
        "pick": {
          "dispatch": "$.dispatch",
          "workspace": "$.workspace",
          "agent": "$.agent",
          "record": "$.record",
          "routing": "$.routing",
          "runtime": "$.runtime",
          "workPlan": "$.workContext.workPlan"
        }
      },
      "assign": "$.finalThreadContext",
      "when": {
        "path": "$.workContext.workPlan.reporting.mode",
        "equals": "flightdeck_task"
      }
    },
    {
      "name": "final-thread-response",
      "description": "Compose the final conversational answer for the source thread.",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 600000,
      "input": {
        "pick": {
          "taskId": "$.workContext.createdTask.taskId",
          "taskSummary": "$.workContext.workPlan.taskSummary",
          "originalPrompt": "$.workContext.workPlan.originalPrompt",
          "originThread": "$.workContext.workPlan.originThread",
          "reporting": "$.workContext.workPlan.reporting",
          "finalThreadMessages": "$.finalThreadContext.thread.recent_messages",
          "workerCompleted": "$.workerResult.completed",
          "workerSummary": "$.workerResult.summary",
          "workerOutput": "$.workerResult.result",
          "workerBlockers": "$.workerResult.blockers",
          "workerEvidence": "$.workerResult.evidence",
          "reviewAccepted": "$.agentResponse.accepted",
          "reviewSummary": "$.agentResponse.reviewSummary",
          "requiredChanges": "$.agentResponse.requiredChanges",
          "risks": "$.agentResponse.risks"
        }
      },
      "prompt": "You are the final response agent for a Wingman pipeline.\n\nYour job is to write the message that will be posted back into the originating Flight Deck thread. Review the original thread, any refreshed thread context, the task/work plan, new worker output, manager review, and any artifacts created by the pipeline.\n\nRules:\n- Be conversational. Write as a direct reply in the thread, not as pipeline telemetry.\n- Be complete. Answer the user's actual question/request using the work that was just completed.\n- If there is a Flight Deck document, WApp, file, or other user-accessible artifact, include the mention/link. Do not make the requester hunt through internal task records.\n- Do not make an internal task the main artifact unless it is the only durable place the result exists.\n- Do not say only that work is \"ready for review\"; summarise or present the useful output.\n- Do not prefix the body with labels like \"Summary:\", \"Task:\", \"Assigned back to:\", or \"Pipeline handoff:\".\n- If the work is incomplete or assumptions matter, say that plainly.\n- If a follow-up question would materially improve the outcome, ask one focused question. If there is an obvious next step, suggest it.\n\nReturn JSON only:\n{\n  \"body\": \"the exact chat reply to post\",\n  \"summary\": \"short internal summary\",\n  \"artifacts\": [{\"type\":\"document|wapp|file|task|other\", \"label\":\"\", \"mentionOrUrl\":\"\"}],\n  \"followUpQuestion\": \"question or null\",\n  \"confidence\": 0.0\n}",
      "assign": "$.finalThreadResponse",
      "when": {
        "path": "$.workContext.workPlan.reporting.mode",
        "equals": "flightdeck_task"
      }
    },
    {
      "name": "move-task-to-review",
      "description": "Move the originating Flight Deck task to Review and assign it back to the requester.",
      "type": "code",
      "function": "dispatch.markTaskReadyForReview",
      "input": {
        "pick": {
          "dispatch": "$.dispatch",
          "workspace": "$.workspace",
          "agent": "$.agent",
          "record": "$.record",
          "routing": "$.routing",
          "runtime": "$.runtime",
          "createdTask": "$.workContext.createdTask",
          "workPlan": "$.workContext.workPlan",
          "workerResult": "$.workerResult",
          "agentResponse": "$.agentResponse",
          "finalThreadContext": "$.finalThreadContext",
          "finalThreadResponse": "$.finalThreadResponse"
        }
      },
      "assign": "$.taskReviewUpdate",
      "when": {
        "path": "$.workContext.workPlan.reporting.mode",
        "equals": "flightdeck_task"
      }
    }
  ]
};

const RESEARCH_AND_REPORT_DEFINITION = {
  "name": "research-and-report",
  "description": "Origin-agnostic research pipeline. A researcher gathers evidence, a report writer prepares the report, then a manager reviews and the pipeline reports either to the originating Flight Deck task/thread or as a direct pipeline result.",
  "default": true,
  "tags": [
    "default",
    "research",
    "report",
    "review",
    "origin-agnostic"
  ],
  "input": {
    "taskId": "task-demo",
    "scopeId": "scope-demo",
    "workdir": "/workspace",
    "assignerNpub": "npub1requester",
    "reviewerNpub": "npub1requester",
    "workPlan": {
      "taskSummary": "Research the requested subject and produce a report.",
      "instructions": "Research the subject from the task and chat context, then write a concise report.",
      "acceptanceCriteria": [
        "The report answers the research question",
        "Sources are cited",
        "Open questions are clearly listed"
      ],
      "executionPlan": [
        "Clarify research questions from the thread",
        "Gather sources and evidence",
        "Write a report document",
        "Review the result"
      ],
      "managerChecklist": [
        "Sources are credible and cited",
        "The report matches the task scope",
        "Limitations and open questions are stated"
      ]
    },
    "reporting": {
      "mode": "pipeline_result",
      "callbackPipelineId": "",
      "callbackRef": {}
    }
  },
  "steps": [
    {
      "name": "normalise-work-plan-context",
      "description": "Normalise direct, chat, and Flight Deck task origins into one work plan and reporting contract.",
      "type": "code",
      "function": "dispatch.normaliseWorkPlanContext",
      "input": {
        "pick": {
          "taskId": "$.taskId",
          "scopeId": "$.scopeId",
          "workdir": "$.workdir",
          "assignerNpub": "$.assignerNpub",
          "reviewerNpub": "$.reviewerNpub",
          "workPlan": "$.workPlan",
          "createdTask": "$.createdTask",
          "reporting": "$.reporting",
          "dispatch": "$.dispatch",
          "workspace": "$.workspace",
          "agent": "$.agent",
          "record": "$.record",
          "routing": "$.routing",
          "runtime": "$.runtime"
        }
      },
      "assign": "$.workContext"
    },
    {
      "name": "research-worker",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 2400000,
      "input": {
        "pick": {
          "createdTask": "$.workContext.createdTask",
          "workPlan": "$.workContext.workPlan"
        }
      },
      "prompt": "You are the researcher in a Wingman research-and-report pipeline. Use only the selected input: createdTask and workPlan. workPlan includes the task plan, originalPrompt, originThread, referencedRecords, instructions, acceptanceCriteria, executionPlan, managerChecklist, and reporting mode. For current-world facts, use internet research and cite sources. Produce structured research notes, not a polished final report. Return JSON fields: completed boolean, researchQuestion string, findings array, sources array of objects or strings, contradictions array, openQuestions array, evidence array, blockers array, confidence number.",
      "assign": "$.researchResult"
    },
    {
      "name": "report-writer",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 1800000,
      "input": {
        "pick": {
          "taskId": "$.workContext.createdTask.taskId",
          "taskSummary": "$.workContext.workPlan.taskSummary",
          "instructions": "$.workContext.workPlan.instructions",
          "acceptanceCriteria": "$.workContext.workPlan.acceptanceCriteria",
          "reporting": "$.workContext.workPlan.reporting",
          "researchQuestion": "$.researchResult.researchQuestion",
          "findings": "$.researchResult.findings",
          "sources": "$.researchResult.sources",
          "contradictions": "$.researchResult.contradictions",
          "openQuestions": "$.researchResult.openQuestions",
          "evidence": "$.researchResult.evidence",
          "blockers": "$.researchResult.blockers"
        }
      },
      "prompt": "You are the report writer in a Wingman research-and-report pipeline. Use only the selected input. Turn the research fields into a concise report. Create or verify a Flight Deck report document only when reporting.mode is flightdeck_task and current Wingman/Autopilot Flight Deck helpers are available in the runtime. Do not run Yoke, do not sync a Yoke workspace, and do not use commandPrefix for Flight Deck PG work. Do not run task update, task comment, chat reply, chat reply-current, docs comment, or any command that changes task state, task comments, document comments, or chat messages. The deterministic Flight Deck closeout step owns task state, task comment, and chat handoff publishing for Flight Deck task runs; direct runs should return the report in the pipeline result. Include source links/citations and limitations. Do not hide uncertainty. Return JSON fields: completed boolean, reportTitle string, reportSummary string, reportBody string, documentId string|null, sources array, blockers array, taskUpdateComment string, confidence number.",
      "assign": "$.workerResult"
    },
    {
      "name": "manager-review",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 1200000,
      "input": {
        "pick": {
          "taskId": "$.workContext.createdTask.taskId",
          "taskSummary": "$.workContext.workPlan.taskSummary",
          "instructions": "$.workContext.workPlan.instructions",
          "acceptanceCriteria": "$.workContext.workPlan.acceptanceCriteria",
          "managerChecklist": "$.workContext.workPlan.managerChecklist",
          "originalPrompt": "$.workContext.workPlan.originalPrompt",
          "originThread": "$.workContext.workPlan.originThread",
          "referencedRecords": "$.workContext.workPlan.referencedRecords",
          "reporting": "$.workContext.workPlan.reporting",
          "researchQuestion": "$.researchResult.researchQuestion",
          "findings": "$.researchResult.findings",
          "sources": "$.researchResult.sources",
          "openQuestions": "$.researchResult.openQuestions",
          "reportTitle": "$.workerResult.reportTitle",
          "reportSummary": "$.workerResult.reportSummary",
          "reportBody": "$.workerResult.reportBody",
          "reportDocumentId": "$.workerResult.documentId",
          "workerBlockers": "$.workerResult.blockers",
          "taskUpdateComment": "$.workerResult.taskUpdateComment"
        }
      },
      "prompt": "You are the manager reviewer in a Wingman research-and-report pipeline. Use only the selected input. Check the research notes and report against instructions, acceptanceCriteria, managerChecklist, originalPrompt, originThread, referencedRecords, and reporting. Verify that sources, limitations, and open questions are represented. For Flight Deck task runs, the deterministic pipeline closeout updates the task to review and assigns it to the requester. For direct runs, return the reviewed research report as the pipeline result. Return JSON fields: accepted boolean, taskSummary string, reviewSummary string, requiredChanges array, risks array, confidence number.",
      "assign": "$.agentResponse"
    },
    {
      "name": "reload-final-thread",
      "description": "Refresh the originating thread before composing the final user-facing response.",
      "type": "code",
      "function": "dispatch.reloadChatThread",
      "input": {
        "pick": {
          "dispatch": "$.dispatch",
          "workspace": "$.workspace",
          "agent": "$.agent",
          "record": "$.record",
          "routing": "$.routing",
          "runtime": "$.runtime",
          "workPlan": "$.workContext.workPlan"
        }
      },
      "assign": "$.finalThreadContext",
      "when": {
        "path": "$.workContext.workPlan.reporting.mode",
        "equals": "flightdeck_task"
      }
    },
    {
      "name": "final-thread-response",
      "description": "Compose the final conversational answer for the source thread.",
      "type": "agent",
      "agent": "$.agent.defaultAgent",
      "directory": "$.workContext.workPlan.workdir",
      "timeoutMs": 600000,
      "input": {
        "pick": {
          "taskId": "$.workContext.createdTask.taskId",
          "taskSummary": "$.workContext.workPlan.taskSummary",
          "originalPrompt": "$.workContext.workPlan.originalPrompt",
          "originThread": "$.workContext.workPlan.originThread",
          "reporting": "$.workContext.workPlan.reporting",
          "finalThreadMessages": "$.finalThreadContext.thread.recent_messages",
          "researchQuestion": "$.researchResult.researchQuestion",
          "reportTitle": "$.workerResult.reportTitle",
          "reportSummary": "$.workerResult.reportSummary",
          "reportDocumentId": "$.workerResult.documentId",
          "reportSources": "$.workerResult.sources",
          "workerBlockers": "$.workerResult.blockers",
          "reviewAccepted": "$.agentResponse.accepted",
          "reviewSummary": "$.agentResponse.reviewSummary",
          "requiredChanges": "$.agentResponse.requiredChanges",
          "risks": "$.agentResponse.risks"
        }
      },
      "prompt": "You are the final response agent for a Wingman pipeline.\n\nYour job is to write the message that will be posted back into the originating Flight Deck thread. Review the original thread, any refreshed thread context, the task/work plan, new worker output, manager review, and any artifacts created by the pipeline.\n\nRules:\n- Be conversational. Write as a direct reply in the thread, not as pipeline telemetry.\n- Be complete. Answer the user's actual question/request using the work that was just completed.\n- If there is a Flight Deck document, WApp, file, or other user-accessible artifact, include the mention/link. Do not make the requester hunt through internal task records.\n- Do not make an internal task the main artifact unless it is the only durable place the result exists.\n- Do not say only that work is \"ready for review\"; summarise or present the useful output.\n- Do not prefix the body with labels like \"Summary:\", \"Task:\", \"Assigned back to:\", or \"Pipeline handoff:\".\n- If the work is incomplete or assumptions matter, say that plainly.\n- If a follow-up question would materially improve the outcome, ask one focused question. If there is an obvious next step, suggest it.\n\nReturn JSON only:\n{\n  \"body\": \"the exact chat reply to post\",\n  \"summary\": \"short internal summary\",\n  \"artifacts\": [{\"type\":\"document|wapp|file|task|other\", \"label\":\"\", \"mentionOrUrl\":\"\"}],\n  \"followUpQuestion\": \"question or null\",\n  \"confidence\": 0.0\n}",
      "assign": "$.finalThreadResponse",
      "when": {
        "path": "$.workContext.workPlan.reporting.mode",
        "equals": "flightdeck_task"
      }
    },
    {
      "name": "move-task-to-review",
      "description": "Move the originating Flight Deck task to Review and assign it back to the requester.",
      "type": "code",
      "function": "dispatch.markTaskReadyForReview",
      "input": {
        "pick": {
          "dispatch": "$.dispatch",
          "workspace": "$.workspace",
          "agent": "$.agent",
          "record": "$.record",
          "routing": "$.routing",
          "runtime": "$.runtime",
          "createdTask": "$.workContext.createdTask",
          "workPlan": "$.workContext.workPlan",
          "researchResult": "$.researchResult",
          "workerResult": "$.workerResult",
          "agentResponse": "$.agentResponse",
          "finalThreadContext": "$.finalThreadContext",
          "finalThreadResponse": "$.finalThreadResponse"
        }
      },
      "assign": "$.taskReviewUpdate",
      "when": {
        "path": "$.workContext.workPlan.reporting.mode",
        "equals": "flightdeck_task"
      }
    }
  ]
};

const AGENT_DISPATCH_COMMENT_DEFINITION = {
  name: "agent-dispatch-comment-response",
  description: "Default dispatch pipeline for task/document comment advisories. It asks one agent step to draft a reply, then publishes it to the source Flight Deck comment thread.",
  default: true,
  tags: ["default", "dispatch", "comment", "flight-deck"],
  input: {
    dispatch: { triggerKind: "comment" },
    workspace: { workspaceOwnerNpub: "npub1workspace", sourceAppNpub: "npub1source" },
    agent: { agentId: "primary", label: "Primary Wingman", workingDirectory: "/workspace", defaultAgent: "codex" },
    record: {
      recordId: "comment-demo",
      recordFamily: "comment",
      payload: {
        commentId: "comment-demo",
        targetRecordId: "task-demo",
        targetRecordFamilyHash: "npub1source:task",
        body: "Can you clarify whether this is blocked?",
        senderNpub: "npub1user",
      },
    },
    routing: { bindingId: "task-demo", bindingType: "task" },
    flightDeckContext: {
      channel: {
        id: "channel-demo",
        scopeId: "scope-demo",
        name: "Demo Channel",
        contextPrompt: "No Specific Channel Context",
        hasSpecificContext: false,
      },
    },
  },
  steps: [
    {
      name: "draft-comment-response",
      type: "agent",
      agent: "$.agent.defaultAgent",
      directory: "$.agent.workingDirectory",
      input: {
        pick: {
          workspaceId: "$.workspace.workspaceId",
          workspaceOwnerNpub: "$.workspace.workspaceOwnerNpub",
          sourceAppNpub: "$.workspace.sourceAppNpub",
          commentId: "$.record.payload.commentId",
          targetRecordId: "$.record.payload.targetRecordId",
          targetRecordFamilyHash: "$.record.payload.targetRecordFamilyHash",
          commentBody: "$.record.payload.body",
          senderNpub: "$.record.payload.senderNpub",
          bindingId: "$.routing.bindingId",
          bindingType: "$.routing.bindingType",
          channelContext: "$.flightDeckContext.channel",
        },
      },
      prompt: "You are handling a Wingman comment dispatch. Read commentBody and channelContext.contextPrompt, then draft a reply for the existing comment thread. Treat channelContext.contextPrompt as channel-specific instructions for how this document/task comment should be handled. Do not run CLI commands or APIs that mutate Flight Deck state yourself; the next deterministic Flight Deck PG/Tower pipeline step will publish the reply. Return JSON fields: replyDraft string, targetNeedsWork boolean, blockers array, nextAction string, confidence number from 0 to 1.",
      assign: "$.agentResponse",
      display: {
        in: [
          { label: "Comment", path: "$.record.payload.body", format: "text" },
          { label: "Channel Context", path: "$.flightDeckContext.channel.contextPrompt", format: "text" },
        ],
        out: [
          { label: "Reply", path: "$.replyDraft", format: "text" },
          { label: "Needs Work", path: "$.targetNeedsWork" },
          { label: "Next Action", path: "$.nextAction", format: "text" },
        ],
      },
    },
    {
      name: "publish-comment-reply",
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      input: {
        pick: {
          dispatch: "$.dispatch",
          workspace: "$.workspace",
          agent: "$.agent",
          record: "$.record",
          routing: "$.routing",
          runtime: "$.runtime",
          agentResponse: "$.agentResponse",
        },
      },
    },
  ],
};

const DESIGN_REVIEW_DEFINITION = {
  name: "design-review",
  description: "Runs Critic and Response agents in a loop over a design document, then a Tidy Up agent makes final judgement calls.",
  default: true,
  tags: ["default", "design", "review", "loop"],
  input: {
    documentUrl: "https://example.com/design-document.md",
    reviewIterations: 5,
    criticAgent: "codex",
    responseAgent: "codex",
    tidyAgent: "codex",
    workingDirectory: "/workspace",
    reviewLoop: {
      iteration: 1,
      index: 0,
      completed: 0,
      total: 5,
      done: false,
    },
  },
  steps: [
    {
      id: "critic-pass",
      name: "critic-pass",
      description: "Agent 1 Critic reviews the current design document and leaves critical inline comments.",
      type: "agent",
      agent: "$.criticAgent",
      directory: "$.workingDirectory",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          loopIndex: "$.reviewLoop.index",
          passNumber: "$.reviewLoop.iteration",
          previousConversation: "$.reviewHistory.items",
          latestResponse: "$.iteration.response",
        },
      },
      prompt: "You are Agent 1: Critic. Use documentUrl to locate and read the current design document. Edit the referenced document directly with inline comment tags using the exact format {{COMMENT_001: ...}}, {{COMMENT_002: ...}} and so on. Be critical where required to improve the design only. Consider the previous Critic/Response conversation when present. Do not include the full document text in the callback JSON. In your JSON result include inlineComments as an array of comment IDs and short excerpts, changedSections as an array of section headings or line references, summary as a detailed feedback summary for the Response agent, keyCriticisms as an array, suggestedImprovements as an array, and confidence as a number from 0 to 1.",
      assign: "$.iteration.critic",
    },
    {
      id: "response-pass",
      name: "response-pass",
      description: "Agent 2 Response reviews the design document and Critic feedback, then responds inline.",
      type: "agent",
      agent: "$.responseAgent",
      directory: "$.workingDirectory",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          loopIndex: "$.reviewLoop.index",
          passNumber: "$.reviewLoop.iteration",
          criticFeedback: "$.iteration.critic",
          previousConversation: "$.reviewHistory.items",
        },
      },
      prompt: "You are Agent 2: Response. Use documentUrl to locate and read the current design document, including Critic tags already written into it. Edit the referenced document directly with inline response tags using the exact format {{RESPONSE_001: ...}}, {{RESPONSE_002: ...}} and so on. Consider criticism carefully; do not immediately take it as valid. Push for your point if it is a better design, and concede where the criticism is valid. The goal is to improve the design only. Do not include the full document text in the callback JSON. In your JSON result include inlineResponses as an array of response IDs and short excerpts, changedSections as an array of section headings or line references, summary as a detailed response summary for the next Critic pass, acceptedCriticism as an array, rejectedCriticism as an array, proposedDesignAdjustments as an array, and confidence as a number from 0 to 1.",
      assign: "$.iteration.response",
    },
    {
      id: "loop-to-critic",
      name: "loop-to-critic",
      description: "Append this Critic/Response exchange and jump back to critic-pass until the configured pass count is complete.",
      type: "loop",
      target: "critic-pass",
      iterations: "$.reviewIterations",
      counter: "$.reviewLoop",
      history: "$.reviewHistory",
      capture: {
        critic: "$.iteration.critic",
        response: "$.iteration.response",
      },
    },
    {
      id: "tidy-up",
      name: "tidy-up",
      description: "Final agent reviews the full conversation and makes design judgement calls.",
      type: "agent",
      agent: "$.tidyAgent",
      directory: "$.workingDirectory",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          reviewHistory: "$.reviewHistory.items",
          finalCriticFeedback: "$.iteration.critic",
          finalResponseFeedback: "$.iteration.response",
        },
      },
      prompt: "You are Agent 3: Tidy Up. Use documentUrl to locate and read the current design document, including all {{COMMENT_001: }} and {{RESPONSE_001: }} tags. Review the conversation outputs from the loop between Critic and Response. Make judgement calls on each issue to improve the design, then edit the referenced document directly with the resolved design text. Do not include the full document text in the callback JSON. Return summary, acceptedChanges as an array, rejectedChanges as an array, finalInlineNotes as an array, cleanedDesignPlan as an array of concise changes made, changedSections as an array of section headings or line references, and confidence as a number from 0 to 1.",
      assign: "$.tidyUp",
    },
    {
      id: "finalise-design-review",
      name: "finalise-design-review",
      description: "Return the full repeated review conversation and final tidy-up judgement.",
      type: "code",
      function: "review.finaliseDesignReview",
      input: {
        pick: {
          documentUrl: "$.documentUrl",
          iterations: "$.reviewIterations",
          reviewHistory: "$.reviewHistory",
          critic: "$.iteration.critic",
          response: "$.iteration.response",
          tidyUp: "$.tidyUp",
        },
      },
    },
  ],
};

export function getPipelineRoot(): string {
  if (process.env.WINGMEN_PIPELINES_ROOT?.trim()) {
    return process.env.WINGMEN_PIPELINES_ROOT.trim();
  }
  return join(homedir(), ".wingmen", "pipelines");
}

export function getSharedPipelineDefinitionsDirectory(): string {
  return join(getPipelineRoot(), "shared", "definitions");
}

export function getSharedPipelineFunctionsDirectory(): string {
  return join(getPipelineRoot(), "shared", "functions");
}

export function getUserPipelineDefinitionsDirectory(ownerAlias: string): string {
  return join(getPipelineRoot(), "users", ownerAlias, "definitions");
}

export function getUserPipelineFunctionsDirectory(ownerAlias: string): string {
  return join(getPipelineRoot(), "users", ownerAlias, "functions");
}

export async function ensurePipelineDirectories(ownerAlias: string | null): Promise<void> {
  await mkdir(getSharedPipelineDefinitionsDirectory(), { recursive: true });
  await mkdir(getSharedPipelineFunctionsDirectory(), { recursive: true });
  if (ownerAlias) {
    await mkdir(getUserPipelineDefinitionsDirectory(ownerAlias), { recursive: true });
    await mkdir(getUserPipelineFunctionsDirectory(ownerAlias), { recursive: true });
  }
  await ensurePipelineGitRepository();
  const documentDiscussionDefinition = await readBundledDefaultDefinition("document-discussion.json");
  const flightDeckDocumentInvocationDefinition = await readBundledDefaultDefinition("fd-document-invocation.json");
  const flightDeckTaskInvocationDefinition = await readBundledDefaultDefinition("fd-task-invocation.json");
  const softwareImplementationReviewLoopDefinition = await readBundledDefaultDefinition("software-implementation-review-loop.json");
  const dailyNoteReviewDefinition = await readBundledDefaultDefinition("daily-note-review.json");
  const defaultDefinitions = [
    ["fd-agent-dispatch-chat.json", buildFlightDeckPgDefaultDefinition(AGENT_DISPATCH_CHAT_DEFINITION as unknown as DeclarativePipeline, "fd-agent-dispatch-chat")],
    ["fd-agent-dispatch-task-response.json", buildFlightDeckPgDefaultDefinition(AGENT_DISPATCH_TASK_DEFINITION as unknown as DeclarativePipeline, "fd-agent-dispatch-task-response")],
    ["fd-agent-dispatch-comment-response.json", buildFlightDeckPgDefaultDefinition(AGENT_DISPATCH_COMMENT_DEFINITION as unknown as DeclarativePipeline, "fd-agent-dispatch-comment-response")],
    ["design-review.json", DESIGN_REVIEW_DEFINITION],
    ["document-discussion.json", documentDiscussionDefinition],
    ["fd-document-invocation.json", flightDeckDocumentInvocationDefinition],
    ["fd-task-invocation.json", flightDeckTaskInvocationDefinition],
    ["do-and-review.json", DO_AND_REVIEW_DEFINITION],
    ["research-and-report.json", RESEARCH_AND_REPORT_DEFINITION],
    ["software-implementation-review-loop.json", softwareImplementationReviewLoopDefinition],
    ["daily-note-review.json", dailyNoteReviewDefinition],
  ] as const;
  const renamedBuiltIns = [
    "demo-agent-dispatch-chat-response.json",
    "demo-agent-dispatch-comment-response.json",
    "demo-agent-dispatch-task-response.json",
    "demo-agent-dispatch-task-review-response.json",
    "demo-declarative-pipeline.json",
    "demo-looped-design-review.json",
    "demo-memory-graph-context.json",
    "demo-paragraph-two-agent-analysis.json",
    "demo-software-implementation-manager-review.json",
    "demo-do-and-review.json",
    "implementation-review-loop.v1.json",
    "implementation-review-loop.v2.json",
    "software-implementation-manager-review.json",
  ];
  for (const fileName of renamedBuiltIns) {
    await rm(join(getSharedPipelineDefinitionsDirectory(), fileName), { force: true }).catch(() => undefined);
  }
  for (const [fileName, definition] of defaultDefinitions) {
    const demoPath = join(getSharedPipelineDefinitionsDirectory(), fileName);
    const nextJson = `${JSON.stringify(definition, null, 2)}\n`;
    if (!existsSync(demoPath) || await readFile(demoPath, "utf8").catch(() => "") !== nextJson) {
      await writeFile(demoPath, nextJson);
    }
  }
}

function buildFlightDeckPgDefaultDefinition(
  definition: DeclarativePipeline,
  name: string,
): DeclarativePipeline {
  const next = structuredClone(definition) as DeclarativePipeline & {
    supersedes?: string;
    tags?: string[];
  };
  next.name = name;
  next.description = `Flight Deck PG workspace-first variant of ${definition.name}. ${definition.description ?? ""}`.trim();
  next.tags = Array.from(new Set([...(Array.isArray(definition.tags) ? definition.tags : []), "flight-deck-pg"]));
  next.supersedes = definition.name;
  return next;
}

async function readBundledDefaultDefinition(fileName: string): Promise<DeclarativePipeline> {
  const url = new URL(`./default-definitions/${fileName}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as DeclarativePipeline;
}

export async function listPipelineDefinitions(ownerAlias: string | null): Promise<PipelineDefinitionRecord[]> {
  await ensurePipelineDirectories(ownerAlias);
  const records: PipelineDefinitionRecord[] = [];
  records.push(...await readDefinitionDirectory(getSharedPipelineDefinitionsDirectory(), "shared", null));
  if (ownerAlias) {
    records.push(...await readDefinitionDirectory(join(getPipelineRoot(), "users", ownerAlias, "definitions"), "user", ownerAlias));
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLatestPipelineDefinitions(ownerAlias: string | null): Promise<PipelineDefinitionRecord[]> {
  return selectLatestPipelineDefinitions(await listPipelineDefinitions(ownerAlias));
}

export function selectLatestPipelineDefinitions(records: PipelineDefinitionRecord[]): PipelineDefinitionRecord[] {
  const latestByFamily = new Map<string, PipelineDefinitionRecord>();
  for (const record of records) {
    const key = [
      record.scope,
      record.ownerAlias ?? "",
      stripVersionSuffix(record.slug),
    ].join(":");
    const existing = latestByFamily.get(key);
    if (!existing || compareDefinitionVersions(record, existing) > 0) {
      latestByFamily.set(key, record);
    }
  }
  return Array.from(latestByFamily.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function ensurePipelineGitRepository(): Promise<void> {
  const root = getPipelineRoot();
  const ignorePath = join(root, ".gitignore");
  if (!existsSync(ignorePath)) {
    await writeFile(ignorePath, [
      ".DS_Store",
      "*.tmp",
      "*.log",
      "*.sqlite",
      "*.sqlite-shm",
      "*.sqlite-wal",
      "runs/",
      "cache/",
      "node_modules/",
      "",
    ].join("\n"));
  }
  if (existsSync(join(root, ".git"))) return;
  Bun.spawnSync(["git", "-C", root, "init"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

export async function getPipelineDefinition(id: string, ownerAlias: string | null): Promise<PipelineDefinitionRecord | null> {
  const requestedId = id.trim();
  if (!requestedId) return null;
  const definitions = await listPipelineDefinitions(ownerAlias);
  const exactDefinition = definitions.find((definition) => definition.id === requestedId);
  if (exactDefinition) return exactDefinition;
  const aliasMatches = definitions.filter((definition) => pipelineDefinitionAliases(definition).includes(requestedId));
  if (!aliasMatches.length) return null;
  return selectLatestPipelineDefinitions(aliasMatches)[0] ?? null;
}

function pipelineDefinitionAliases(definition: PipelineDefinitionRecord): string[] {
  const fileName = basename(definition.path);
  return [
    definition.slug,
    definition.name,
    definition.path,
    fileName,
    basename(fileName, ".json"),
    typeof definition.spec.supersedes === "string" ? definition.spec.supersedes : "",
  ];
}

async function readDefinitionDirectory(
  directory: string,
  scope: PipelineScope,
  ownerAlias: string | null,
): Promise<PipelineDefinitionRecord[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const records: PipelineDefinitionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const raw = await readFile(path, "utf8");
    let spec: DeclarativePipeline;
    try {
      spec = JSON.parse(raw) as DeclarativePipeline;
    } catch (error) {
      console.warn("[pipelines] skipping invalid pipeline definition", path, error instanceof Error ? error.message : String(error));
      continue;
    }
    const slug = basename(entry.name, ".json");
    records.push({
      id: buildDefinitionId(scope, ownerAlias, path),
      slug,
      name: spec.name || slug,
      scope,
      ownerAlias,
      path,
      spec,
    });
  }
  return records;
}

function buildDefinitionId(scope: PipelineScope, ownerAlias: string | null, path: string): string {
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return scope === "shared" ? `shared:${hash}` : `user:${ownerAlias ?? "unknown"}:${hash}`;
}

export function makePipelineSlug(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const slug = words.join("-");
  return slug || `pipeline-${new Date().toISOString().slice(0, 10)}`;
}

export async function nextVersionedDefinitionPath(directory: string, slug: string): Promise<string> {
  return nextVersionedPath(directory, slug, "json");
}

export async function nextVersionedFunctionPath(directory: string, slug: string): Promise<string> {
  return nextVersionedPath(directory, slug, "ts");
}

async function nextVersionedPath(directory: string, slug: string, extension: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const baseSlug = stripVersionSuffix(makePipelineSlug(slug));
  const entries = existsSync(directory) ? await readdir(directory, { withFileTypes: true }) : [];
  const versions = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(new RegExp(`^${escapeRegExp(baseSlug)}\\.v(\\d+)\\.${escapeRegExp(extension)}$`)))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value > 0);
  const next = versions.length ? Math.max(...versions) + 1 : 1;
  return join(directory, `${baseSlug}.v${next}.${extension}`);
}

export async function nextVersionedDefinitionPathForSource(sourcePath: string): Promise<string> {
  const sourceSlug = basename(sourcePath, ".json");
  return nextVersionedDefinitionPath(dirname(sourcePath), stripVersionSuffix(sourceSlug));
}

function stripVersionSuffix(value: string): string {
  return value.replace(/\.v\d+$/i, "");
}

function compareDefinitionVersions(a: PipelineDefinitionRecord, b: PipelineDefinitionRecord): number {
  const versionDelta = definitionVersionNumber(a) - definitionVersionNumber(b);
  if (versionDelta !== 0) return versionDelta;
  return a.path.localeCompare(b.path);
}

function definitionVersionNumber(record: PipelineDefinitionRecord): number {
  const specVersion = Number(record.spec.version);
  if (Number.isFinite(specVersion)) return specVersion;
  const slugVersion = record.slug.match(/\.v(\d+)$/i);
  return slugVersion ? Number(slugVersion[1]) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
