import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { DeclarativePipeline } from "./declarative";
import { builtinPipelineFunctions } from "./functions";
import { getPipelineDefinition, type PipelineDefinitionRecord } from "./pipeline-loader";
import { runDeclarativePipeline } from "./pipeline-runner";
import { PipelineStore, type JsonObject } from "./pipeline-store";

const seededPipelineSpecs = new Map<string, DeclarativePipeline>();
let tempPipelineRoot: string | null = null;
let previousPipelineRoot: string | undefined;

beforeAll(async () => {
  previousPipelineRoot = process.env.WINGMEN_PIPELINES_ROOT;
  tempPipelineRoot = mkdtempSync(join(tmpdir(), "wingmen-functions-pipeline-root-"));
  process.env.WINGMEN_PIPELINES_ROOT = tempPipelineRoot;

  const seededDefinitions = [
    ["agent-dispatch-chat.json", "agent-dispatch-chat"],
    ["agent-dispatch-task-response.json", "agent-dispatch-task-response"],
    ["document-discussion.json", "document-discussion"],
    ["fd-document-invocation.json", "fd-document-invocation"],
    ["fd-task-invocation.json", "fd-task-invocation"],
  ] as const;
  for (const [fileName, slug] of seededDefinitions) {
    const definition = await getPipelineDefinition(slug, "functions-test");
    if (!definition) {
      throw new Error(`Seeded pipeline definition missing: ${slug}`);
    }
    seededPipelineSpecs.set(fileName, structuredClone(definition.spec) as DeclarativePipeline);
  }
});

afterAll(() => {
  if (previousPipelineRoot === undefined) {
    delete process.env.WINGMEN_PIPELINES_ROOT;
  } else {
    process.env.WINGMEN_PIPELINES_ROOT = previousPipelineRoot;
  }
  if (tempPipelineRoot) {
    rmSync(tempPipelineRoot, { recursive: true, force: true });
  }
});

function loadSharedPipelineSpec(fileName: string): DeclarativePipeline {
  const spec = seededPipelineSpecs.get(fileName);
  if (!spec) {
    throw new Error(`Seeded pipeline definition not loaded: ${fileName}`);
  }
  return structuredClone(spec) as DeclarativePipeline;
}

test("system restart-and-resume pipeline function requires an explicit Autopilot URL", async () => {
  const result = await builtinPipelineFunctions["system.restartAndResume"]({});
  expect(result).toEqual({
    status: "failed",
    scheduled: false,
    error: "autopilot_url_required",
  });
});

test("chat intent input includes Flight Deck channel context", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]({
    dispatch: { routeId: "route-1", triggerKind: "chat" },
    workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
    agent: { workingDirectory: "/repo", defaultAgent: "codex" },
    record: { recordId: "message-1", payload: { body: "Please update the feature doc.", sender_npub: "npub1requester" } },
    chat: { messageText: "Please update the feature doc.", senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
    routing: { channelId: "channel-1", threadId: "thread-1" },
    chatContext: {
      shouldProceed: true,
      thread: {
        recent_messages: [
          { message_id: "message-1", sender_npub: "npub1requester", body: "Please update the feature doc." },
        ],
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Features",
        contextPrompt: "Iterate on the Flight Deck feature document before implementing.",
        hasSpecificContext: true,
      },
    },
  });

  expect(result.channelContext).toEqual({
    channelId: "channel-1",
    scopeId: "scope-1",
    name: "Features",
    contextPrompt: "Iterate on the Flight Deck feature document before implementing.",
    hasSpecificContext: true,
  });
  expect(result.notes).toContain("Use channelContext.contextPrompt as channel-specific instructions for how this work should be handled.");
});

test("channel context sentinel is not treated as specific context", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]({
    dispatch: { routeId: "route-1", triggerKind: "chat" },
    workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
    agent: { workingDirectory: "/repo", defaultAgent: "codex" },
    record: { recordId: "message-1", payload: { body: "Hello", sender_npub: "npub1requester" } },
    chat: { messageText: "Hello", senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
    routing: { channelId: "channel-1", threadId: "thread-1" },
    chatContext: {
      shouldProceed: true,
      channelContext: {
        channelId: "channel-1",
        contextPrompt: "No Specific Channel Context",
        hasSpecificContext: true,
      },
    },
  });

  expect(result.channelContext).toMatchObject({
    contextPrompt: "No Specific Channel Context",
    hasSpecificContext: false,
  });
});

test("dispatch.prepareShortLookupAnswer answers greetings without an agent", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareShortLookupAnswer"]!({
    chatDispatchInput: {
      latestThread: [
        { messageId: "message-1", body: "Hey" },
      ],
    },
  });

  expect(result).toMatchObject({
    skipAgent: true,
    intent: "answer_now",
    dispatchTask: false,
    chatResponse: { body: "Hello." },
    shortLookup: { kind: "greeting" },
  });
});

test("dispatch.prepareShortLookupAnswer leaves named greetings for classification", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareShortLookupAnswer"]!({
    chatDispatchInput: {
      latestThread: [
        { messageId: "message-1", body: "Hey teammate" },
      ],
    },
  });

  expect(result).toMatchObject({
    skipAgent: false,
    intent: "needs_classification",
    dispatchTask: false,
    chatResponse: { body: "" },
  });
});

test("dispatch.prepareShortLookupAnswer leaves ordinary chat for classification", async () => {
  const result = await builtinPipelineFunctions["dispatch.prepareShortLookupAnswer"]!({
    chatDispatchInput: {
      latestThread: [
        { messageId: "message-1", body: "Can you build the new WApp screen?" },
      ],
    },
  });

  expect(result).toMatchObject({
    skipAgent: false,
    intent: "needs_classification",
    dispatchTask: false,
  });
});

test("dispatch.prepareShortLookupAnswer answers focus questions from Daily Scope", async () => {
  const previousWingmanPriv = process.env.WINGMAN_PRIV;
  const previousFetch = globalThis.fetch;
  const requested: { url?: string; appNpub?: string | null; authorization?: string | null } = {};
  process.env.WINGMAN_PRIV = nip19.nsecEncode(generateSecretKey());
  globalThis.fetch = (async (input, init) => {
    requested.url = String(input);
    const headers = new Headers(init?.headers);
    requested.appNpub = headers.get("x-flightdeck-pg-app-npub");
    requested.authorization = headers.get("authorization");
    return Response.json({
      daily_notes: [
        {
          id: "daily-1",
          note_date: new Date().toISOString().slice(0, 10),
          title: "Daily Scope",
          focus: "Make Flight Deck and Autopilot demo-ready.",
          items: [
            { title: "Tighten deploy/connect path", status: "in_progress" },
            { title: "Keep Plantrite contained", status: "completed" },
          ],
        },
      ],
    });
  }) as typeof fetch;

  let result: Record<string, unknown>;
  try {
    result = await builtinPipelineFunctions["dispatch.prepareShortLookupAnswer"]!({
      workspace: {
        backendBaseUrl: "http://tower.local",
        workspaceId: "workspace-1",
        sourceAppNpub: "npub1app",
      },
      chatDispatchInput: {
        latestThread: [
          { messageId: "message-1", body: "What's our focus today?" },
        ],
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWingmanPriv === undefined) delete process.env.WINGMAN_PRIV;
    else process.env.WINGMAN_PRIV = previousWingmanPriv;
  }

  expect(requested.url).toContain("http://tower.local/api/v4/flightdeck-pg/workspaces/workspace-1/daily-notes");
  expect(requested.appNpub).toBe("npub1app");
  expect(requested.authorization).toStartWith("Nostr ");
  expect(result).toMatchObject({
    skipAgent: true,
    intent: "answer_now",
    dispatchTask: false,
    shortLookup: {
      kind: "daily_focus",
      fetched: true,
      found: true,
      dailyNoteId: "daily-1",
    },
  });
  expect(((result.chatResponse as any).body as string)).toContain("Make Flight Deck and Autopilot demo-ready.");
  expect(((result.chatResponse as any).body as string)).toContain("Tighten deploy/connect path");
  expect(((result.chatResponse as any).body as string)).toContain("1/2 Daily Scope items complete");
});

test("task work plans preserve Flight Deck channel context for child sessions", async () => {
  const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]({
    agentResponse: {
      accepted: true,
      workStyle: "do_and_review",
      taskSummary: "Clarify the document request.",
      confidence: 0.8,
    },
    record: {
      payload: {
        title: "Clarify docs",
        description: "Review the latest document request.",
      },
    },
    agent: { workingDirectory: "/repo" },
    flightDeckContext: {
      channel: {
        id: "channel-1",
        scopeId: "scope-1",
        name: "Docs",
        contextPrompt: "Use docs for iteration; do not create tasks for document-only work.",
        hasSpecificContext: true,
      },
    },
  });

  expect(result.channelContext).toEqual({
    channelId: "channel-1",
    scopeId: "scope-1",
    name: "Docs",
    contextPrompt: "Use docs for iteration; do not create tasks for document-only work.",
    hasSpecificContext: true,
  });
});

test("chat task pipeline selection treats hashed software pipeline ids as requiring a target surface", async () => {
  const result = await builtinPipelineFunctions["dispatch.normaliseChatTaskPipelineSelection"]!({
    decision: {
      requestedDispatchTask: true,
      taskRoutingPending: true,
      intent: "create_task",
      responseDraft: "Starting the implementation task.",
      taskDraft: {
        title: "Fix mobile focus rendering",
        instructions: "Fix the focus component on mobile.",
      },
      workPlan: {
        taskSummary: "Fix mobile focus rendering",
        instructions: "Fix the focus component on mobile.",
      },
    },
    taskPipelineInput: {
      validChildPipelines: [
        {
          id: "shared:1ced4704717e",
          slug: "software-implementation-review-loop",
          name: "software-implementation-review-loop",
        },
      ],
    },
    taskPipelineDecision: {
      recommendedPipelineId: "shared:1ced4704717e",
      workdir: "/srv/code/wingmanbefree/autopilot/data/agent-chat-workspaces/fd-test",
      confidence: 0.99,
    },
  });

  expect(result).toMatchObject({
    dispatchTask: false,
    pipelineDefinitionId: null,
    taskRoutingPending: false,
    missing: ["targetSurface", "non-placeholder workdir"],
  });
  expect(String(result.responseDraft)).toContain("targetSurface");
});

test("chat task pipeline selection accepts hashed software pipeline ids with a concrete contract", async () => {
  const result = await builtinPipelineFunctions["dispatch.normaliseChatTaskPipelineSelection"]!({
    decision: {
      requestedDispatchTask: true,
      taskRoutingPending: true,
      intent: "create_task",
      responseDraft: "Starting the implementation task.",
      taskDraft: {
        title: "Fix mobile focus rendering",
        instructions: "Fix the focus component on mobile.",
      },
      workPlan: {
        taskSummary: "Fix mobile focus rendering",
        instructions: "Fix the focus component on mobile.",
      },
    },
    taskPipelineInput: {
      validChildPipelines: [
        {
          id: "shared:1ced4704717e",
          slug: "software-implementation-review-loop",
          name: "software-implementation-review-loop",
        },
      ],
    },
    taskPipelineDecision: {
      recommendedPipelineId: "shared:1ced4704717e",
      workdir: "/srv/code/wingmanbefree/wm-fd-2",
      scopeId: "scope-1",
      targetSurface: {
        surface: "Daily focus mobile view",
        existingFiles: ["src/app.js", "src/styles.css"],
      },
      confidence: 0.99,
    },
  });

  expect(result).toMatchObject({
    dispatchTask: true,
    pipelineDefinitionId: "shared:1ced4704717e",
    workdir: "/srv/code/wingmanbefree/wm-fd-2",
    taskRoutingPending: false,
    workPlan: {
      targetSurface: {
        surface: "Daily focus mobile view",
        existingFiles: ["src/app.js", "src/styles.css"],
      },
    },
  });
});

test("morning Daily Scope extraction preserves completed items and caps checklist", async () => {
  const result = await builtinPipelineFunctions["daily.extractMorningScope"]!({
    ownerNpub: "npub-human",
    noteDate: "2026-06-17",
    existingDailyScope: {
      body: "Earlier context",
      items: [
        { id: "done-1", text: "Already shipped the release notes", completed: true, source: "manual" },
      ],
    },
    transcript: [
      "Ship the Kindling pipeline updates.",
      "Review the Flight Deck Daily Scope toggle.",
      "Call Sam about Plantrite rollout.",
      "Deploy the Tower contract changes.",
      "Prepare the customer morning brief.",
      "Fix the Autopilot helper tests.",
    ].join(" "),
  });

  expect(result.ownerNpub).toBe("npub-human");
  expect(result.noteDate).toBe("2026-06-17");
  expect(result.items).toHaveLength(5);
  expect(result.items[0]).toMatchObject({
    id: "done-1",
    text: "Already shipped the release notes",
    completed: true,
    source: "manual",
  });
  expect(result.items.every((item: any) => typeof item.text === "string" && item.text.length > 0)).toBe(true);
  expect(result.parkedItems.length).toBeGreaterThan(0);
});

function executableChatDispatchSpec(agentDecision: JsonObject, agentWorkDecision: JsonObject, taskPipelineDecision: JsonObject): DeclarativePipeline {
  const spec = structuredClone(loadSharedPipelineSpec("agent-dispatch-chat.json")) as DeclarativePipeline;
  spec.steps = spec.steps.map((step) => {
    if (step.name === "analyse-intent") {
      return {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.agentDecision",
        assign: step.assign,
        when: step.when,
      };
    }
    if (step.name === "dispatch-agent") {
      return {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.agentWorkDecision",
        assign: step.assign,
        when: step.when,
      };
    }
    if (step.name === "select-task-pipeline") {
      return {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.taskPipelineDecision",
        assign: step.assign,
        when: step.when,
      };
    }
    return step;
  });
  return {
    ...spec,
    input: {
      ...spec.input,
      testAgentDecision: agentDecision,
      testAgentWorkDecision: agentWorkDecision,
      testTaskPipelineDecision: taskPipelineDecision,
    },
  };
}

async function runChatDispatchSpec(input: {
  agentDecision: JsonObject;
  agentWorkDecision?: JsonObject;
  latestMessage: string;
  agent?: JsonObject;
  channelContext?: JsonObject;
  referencedRecords?: unknown[];
}) {
  const agentWorkDecision = input.agentWorkDecision ?? {
    action: "reply",
    chatResponse: { body: "I checked that and can answer directly." },
    confidence: 0.9,
  };
  const taskPipelineDecision = {
    recommendedPipelineId: "do-and-review",
    workdir: "/repo",
    confidence: 0.9,
  };
  const definition: PipelineDefinitionRecord = {
    id: "shared:test-agent-dispatch-chat",
    slug: "agent-dispatch-chat",
    name: "agent-dispatch-chat",
    scope: "shared",
    ownerAlias: null,
    path: join(tempPipelineRoot ?? tmpdir(), "shared", "definitions", "agent-dispatch-chat.json"),
    spec: executableChatDispatchSpec(input.agentDecision, agentWorkDecision, taskPipelineDecision),
  };
  const store = new PipelineStore(join(tmpdir(), `wingmen-chat-dispatch-${randomUUID()}.sqlite`));
  const registry = {
    ...builtinPipelineFunctions,
    "test.agentDecision": async (selected: JsonObject) => selected.testAgentDecision as JsonObject,
    "test.agentWorkDecision": async (selected: JsonObject) => selected.testAgentWorkDecision as JsonObject,
    "test.taskPipelineDecision": async (selected: JsonObject) => selected.testTaskPipelineDecision as JsonObject,
    "dispatch.setResponseActivity": async (selected: JsonObject) => ({
      status: selected.status ?? "ok",
      label: selected.label ?? null,
      expiresInSeconds: selected.expiresInSeconds ?? null,
    }),
    "dispatch.hydrateChatContext": async () => ({
      hydrated: true,
      status: "ok",
      shouldProceed: true,
      channelContext: input.channelContext,
      thread: {
        recent_messages: [
          {
            message_id: "message-1",
            sender_npub: "npub1requester",
            body: input.latestMessage,
          },
        ],
      },
      referencedRecords: input.referencedRecords ?? [],
      availablePipelines: [
        { id: "document-discussion", slug: "document-discussion", name: "document-discussion", scope: "shared" },
        { id: "discussion-chat-response", slug: "discussion-chat-response", name: "discussion-chat-response", scope: "shared" },
        { id: "do-and-review", slug: "do-and-review", name: "do-and-review", scope: "shared" },
        { id: "software-implementation-review-loop", slug: "software-implementation-review-loop", name: "software-implementation-review-loop", scope: "shared" },
      ],
      scopes: [],
    }),
    "dispatch.createChatTask": async (selected: JsonObject) => ({
      created: true,
      status: "ok",
      taskId: "task-created",
      pipelineDefinitionId: String((selected.decision as JsonObject | undefined)?.pipelineDefinitionId ?? "do-and-review"),
      workPlan: (() => {
        const workPlan = ((selected.decision as JsonObject | undefined)?.workPlan as JsonObject | undefined) ?? {};
        const pipelineDefinitionId = String((selected.decision as JsonObject | undefined)?.pipelineDefinitionId ?? "do-and-review");
        return {
          ...workPlan,
        taskId: "task-created",
          pipelineDefinitionId,
          childPipelineDefinitionId: pipelineDefinitionId,
        };
      })(),
      ...(() => {
        const decision = (selected.decision as JsonObject | undefined) ?? {};
        const launches = Array.isArray(decision.pipelineLaunches)
          ? decision.pipelineLaunches.map((entry) => entry as JsonObject)
          : [];
        if (decision.pipelinesRequired !== true || launches.length === 0) return {};
        return {
          operation: "tasks.create-from-chat.multi",
          items: launches.map((launch, index) => {
            const requirementId = String(launch.requirementId ?? `requirement-${index + 1}`);
            const workPlan = (launch.workPlan as JsonObject | undefined) ?? {};
            return {
              requirementId,
              created: true,
              status: "ok",
              taskId: `task-${requirementId}`,
              pipelineDefinitionId: launch.pipelineDefinitionId,
              workPlan: {
                ...workPlan,
                requirementId,
                taskId: `task-${requirementId}`,
                pipelineDefinitionId: launch.pipelineDefinitionId,
                childPipelineDefinitionId: launch.pipelineDefinitionId,
              },
            };
          }),
        };
      })(),
    }),
    "dispatch.startChildPipeline": async (selected: JsonObject) => ({
      started: true,
      status: "running",
      pipelineRunId: `run-${String(selected.pipelineDefinitionId)}`,
      pipelineDefinitionId: selected.pipelineDefinitionId,
      pipelineName: selected.pipelineDefinitionId,
      workPlan: selected.workPlan,
    }),
    "dispatch.startChildPipelines": async (selected: JsonObject) => {
      const pipelines = Array.isArray(selected.pipelines) ? selected.pipelines.map((entry) => entry as JsonObject) : [];
      const createdTask = (selected.createdTask as JsonObject | undefined) ?? {};
      const createdItems = Array.isArray(createdTask.items) ? createdTask.items.map((entry) => entry as JsonObject) : [];
      return {
        started: pipelines.length > 0,
        status: pipelines.length > 0 ? "running" : "failed",
        total: pipelines.length,
        items: pipelines.map((entry) => {
          const matchingTask = createdItems.find((item) => item.requirementId === entry.requirementId);
          return {
            requirementId: entry.requirementId,
            taskId: matchingTask?.taskId,
            started: true,
            status: "running",
            pipelineRunId: `run-${String(entry.requirementId)}`,
            pipelineDefinitionId: entry.pipelineDefinitionId,
            pipelineName: entry.pipelineDefinitionId,
            workPlan: {
              ...((entry.workPlan as JsonObject | undefined) ?? {}),
              ...(((matchingTask?.workPlan as JsonObject | undefined) ?? {})),
            },
          };
        }),
      };
    },
    "dispatch.completeReviewTaskFromChat": async (selected: JsonObject) => ({
      completed: true,
      status: "done",
      taskId: (selected.reviewApproval as JsonObject)?.taskId,
      taskTitle: (selected.reviewApproval as JsonObject)?.taskTitle,
    }),
    "dispatch.reloadChatThread": async () => ({
      hydrated: true,
      status: "ok",
      operation: "chat.reload-thread",
    }),
    "dispatch.ensureDiscussionDocument": async () => ({
      ensured: true,
      status: "created",
      operation: "docs.ensure-discussion-document",
      documentId: "doc-created",
      documentMention: "@[Document discussion](mention:document:doc-created)",
    }),
    "dispatch.publishFlightDeckResponse": async (selected: JsonObject) => ({
      ...selected,
      published: true,
      status: "ok",
      agentResponse: selected.agentResponse,
    }),
  };

  const run = await runDeclarativePipeline({
    store,
    definition,
    registry,
    input: {
      testAgentDecision: input.agentDecision,
      testAgentWorkDecision: agentWorkDecision,
      testTaskPipelineDecision: taskPipelineDecision,
      dispatch: { triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: input.agent ?? { workingDirectory: "/repo", defaultAgent: "codex" },
      record: { recordId: "message-1", payload: { body: input.latestMessage, sender_npub: "npub1requester" } },
      chat: { messageText: input.latestMessage, senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      routing: { channelId: "channel-1", threadId: "thread-1", bindingType: "thread" },
    },
    ownerNpub: "npub1owner",
    ownerAlias: "sample-operator",
    callbackOrigin: "http://localhost",
    sessionApiContext: {} as never,
  });
  return {
    run,
    steps: store.listSteps(run.id),
  };
}

function executableTaskDispatchSpec(agentResponse: JsonObject): DeclarativePipeline {
  const spec = structuredClone(loadSharedPipelineSpec("agent-dispatch-task-response.json")) as DeclarativePipeline;
  spec.steps = spec.steps.map((step) => step.name === "investigate-and-route-task"
    ? {
        name: step.name,
        description: step.description,
        type: "code",
        function: "test.agentResponse",
        input: {
          pick: {
            testAgentResponse: "$.testAgentResponse",
          },
        },
        assign: step.assign,
      }
    : step);
  return {
    ...spec,
    input: {
      ...spec.input,
      testAgentResponse: agentResponse,
    },
  };
}

async function runTaskDispatchSpec(input: {
  agentResponse: JsonObject;
  taskDescription: string;
  taskId?: string;
}) {
  const taskId = input.taskId ?? "task-demo";
  const definition: PipelineDefinitionRecord = {
    id: "shared:test-agent-dispatch-task-response",
    slug: "agent-dispatch-task-response",
    name: "agent-dispatch-task-response",
    scope: "shared",
    ownerAlias: null,
    path: join(tempPipelineRoot ?? tmpdir(), "shared", "definitions", "agent-dispatch-task-response.json"),
    spec: executableTaskDispatchSpec(input.agentResponse),
  };
  const store = new PipelineStore(join(tmpdir(), `wingmen-task-dispatch-${randomUUID()}.sqlite`));
  const registry = {
    ...builtinPipelineFunctions,
    "test.agentResponse": async (selected: JsonObject) => selected.testAgentResponse as JsonObject,
    "dispatch.markTaskInProgress": async (selected: JsonObject) => ({
      published: true,
      status: "ok",
      workPlan: selected.workPlan,
    }),
    "dispatch.startChildPipeline": async (selected: JsonObject) => ({
      started: true,
      status: "running",
      pipelineDefinitionId: selected.pipelineDefinitionId,
      workPlan: selected.workPlan,
      childInputWorkPlan: (selected.childInput as JsonObject | undefined)?.workPlan,
    }),
    "dispatch.publishFlightDeckResponse": async (selected: JsonObject) => ({
      published: true,
      status: "ok",
      agentResponse: selected.agentResponse,
      childPipeline: selected.childPipeline,
    }),
  };

  const run = await runDeclarativePipeline({
    store,
    definition,
    registry,
    input: {
      testAgentResponse: input.agentResponse,
      dispatch: { triggerKind: "task" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      record: {
        recordId: taskId,
        payload: {
          task_id: taskId,
          title: "Implement PH1 task",
          description: input.taskDescription,
          state: "ready",
          assigned_to: "npub1bot",
        },
      },
      routing: { bindingId: taskId, bindingType: "task", changedFields: ["state"] },
    },
    ownerNpub: "npub1owner",
    ownerAlias: "sample-operator",
    callbackOrigin: "http://localhost",
    sessionApiContext: {} as never,
  });
  return {
    run,
    steps: store.listSteps(run.id),
  };
}

function currentAfterStep(runResult: Awaited<ReturnType<typeof runChatDispatchSpec>>, stepName: string): JsonObject {
  return (runResult.steps.find((step) => step.name === stepName)?.result ?? {}) as JsonObject;
}

function taskAfterStep(runResult: Awaited<ReturnType<typeof runTaskDispatchSpec>>, stepName: string): JsonObject {
  return (runResult.steps.find((step) => step.name === stepName)?.result ?? {}) as JsonObject;
}

describe("memory pipeline functions", () => {
  test("dispatch.publishFlightDeckResponse is a dry-run outside dispatch routes", async () => {
    const result = await builtinPipelineFunctions["dispatch.publishFlightDeckResponse"]!({
      agentResponse: { responseDraft: "hello" },
    });

    expect(result.published).toBe(false);
    expect(result.status).toBe("not_configured");
    expect(result.agentResponse).toEqual({ responseDraft: "hello" });
  });

  test("dispatch.setResponseActivity is a dry-run outside dispatch routes", async () => {
    const result = await builtinPipelineFunctions["dispatch.setResponseActivity"]!({
      status: "thinking",
      label: "Thinking",
      expiresInSeconds: 90,
    });

    expect(result).toMatchObject({
      published: false,
      status: "not_configured",
      operation: "chat.set-response-activity",
      activity: {
        status: "thinking",
        label: "Thinking",
        expiresInSeconds: 90,
      },
    });
  });

  test("dispatch task state functions are dry-runs outside dispatch routes", async () => {
    await expect(builtinPipelineFunctions["dispatch.markTaskInProgress"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-in-progress",
      taskId: "task-1",
    });
    await expect(builtinPipelineFunctions["dispatch.markTaskReadyForReview"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.move-to-review",
      taskId: "task-1",
    });
    await expect(builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "ready",
      operation: "implementation-review-context.normalise",
      taskId: "task-1",
      workPlan: {
        taskId: "task-1",
        origin: { kind: "direct" },
        reporting: { mode: "pipeline_result" },
      },
    });
    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: {
        taskId: "task-1",
        workPlan: {
          workdir: "/tmp/project",
          instructions: "Implement the target surface.",
          designDocumentUrl: "mention:document:11111111-1111-4111-8111-111111111111",
          targetSurface: {
            route: "/flight-deck",
            existingFiles: ["index.html"],
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      status: "ok",
      operation: "implementation-contract.validate",
      taskId: "task-1",
    });
    await expect(builtinPipelineFunctions["dispatch.commentImplementationReviewProgress"]!({ taskId: "task-1" })).resolves.toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.comment-implementation-review-progress",
      taskId: "task-1",
    });
  });

  test("dispatch.validateImplementationContract rejects placeholder implementation input", async () => {
    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: {
        workPlan: {
          workdir: "/workspace",
          instructions: "Implement the design.",
          designDocumentUrl: "/workspace/docs/example-design.md",
        },
      },
    })).rejects.toThrow(/non-placeholder workdir/);
  });

  test("dispatch.validateImplementationContract rejects missing target surface", async () => {
    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: {
        taskId: "task-loose",
        workPlan: {
          workdir: "/repo/project",
          instructions: "Implement the requested feature from the source context.",
        },
      },
    })).rejects.toThrow(/targetSurface/);
  });

  test("dispatch.validateImplementationContract accepts plural target surface aliases", async () => {
    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: {
        taskId: "task-1",
        workPlan: {
          workdir: "/repo/project",
          instructions: "Implement the target surface.",
          designDocumentUrl: "mention:document:11111111-1111-4111-8111-111111111111",
          targetSurface: {
            surfaces: ["Docs route header", "Docs route navigation"],
            likelyFilesOrAreas: ["src/routes/docs/**", "src/components/docs/**"],
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      targetSurface: {
        surface: "Docs route header",
        existingFiles: ["src/routes/docs/**", "src/components/docs/**"],
      },
    });
  });

  test("dispatch.validateImplementationContract accepts software repo target surfaces", async () => {
    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: {
        taskId: "task-word5",
        workPlan: {
          workdir: "/Users/example/code/games/word5",
          instructions: "Fix skipped game number streak handling.",
          designDocumentUrl: "flightdeck-chat-thread://thread-1#message-1",
          targetSurface: {
            type: "software_repo",
            repo: "https://github.com/example-org/word5",
            localPath: "/Users/example/code/games/word5",
            primaryFiles: ["index.html", "js/nostr-ui.js", "js/nostr-post.js"],
            behaviors: ["local game completion streak update", "Nostr history reconstruction"],
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      targetSurface: {
        surface: "https://github.com/example-org/word5",
        existingFiles: ["index.html", "js/nostr-ui.js", "js/nostr-post.js"],
      },
    });
  });

  test("dispatch.ensureImplementationReviewTask normalises direct software loop input", async () => {
    const result = await builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({
      taskTitle: "Build the thing",
      workingDirectory: "/repo/project",
      implementationPrompt: "Implement the target.",
      designDocumentUrl: "/repo/project/docs/ticket.md",
      targetSurface: {
        route: "clis/wingman.ts flightdeck",
        existingFiles: ["clis/wingman.ts"],
      },
      visualReferences: ["screenshot.png"],
    });

    expect(result).toMatchObject({
      published: false,
      status: "ready",
      operation: "implementation-review-context.normalise",
      taskId: null,
      taskBacked: false,
      workPlan: {
        taskTitle: "Build the thing",
        taskSummary: "Build the thing",
        origin: { kind: "direct" },
        workdir: "/repo/project",
        instructions: "Implement the target.",
        designDocumentUrl: "/repo/project/docs/ticket.md",
        targetSurface: {
          route: "clis/wingman.ts flightdeck",
          existingFiles: ["clis/wingman.ts"],
        },
        visualReferences: ["screenshot.png"],
        reporting: { mode: "pipeline_result" },
      },
    });

    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: result,
    })).resolves.toMatchObject({
      ok: true,
      status: "ok",
      taskId: null,
      workdir: "/repo/project",
    });
  });

  test("dispatch.ensureImplementationReviewTask synthesizes chat-thread design reference for direct chat software runs", async () => {
    const result = await builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({
      dispatch: { triggerKind: "chat" },
      chat: { channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1" },
      workPlan: {
        origin: {
          triggerKind: "chat",
          channelId: "channel-1",
          threadId: "thread-1",
          messageId: "message-1",
        },
        reporting: { mode: "chat_thread" },
        workdir: "/repo/project",
        instructions: "Implement from the current chat thread.",
        targetSurface: {
          route: "/docs",
          existingFiles: ["src/app.js"],
        },
      },
    });

    expect(result).toMatchObject({
      published: false,
      taskId: null,
      taskBacked: true,
      workPlan: {
        origin: { kind: "chat_thread" },
        reporting: { mode: "chat_thread" },
        designDocumentUrl: "flightdeck-chat-thread://thread-1#message-1",
      },
    });
    await expect(builtinPipelineFunctions["dispatch.validateImplementationContract"]!({
      createdTask: result,
    })).resolves.toMatchObject({
      ok: true,
      taskId: null,
      workdir: "/repo/project",
    });
  });

  test("dispatch.ensureImplementationReviewTask recovers task id from task mention", async () => {
    const result = await builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({
      workPlan: {
        taskMention: "@[Existing task](mention:task:127ec051-d7cc-4218-a480-d6b4dd7e0d6d)",
        workdir: "/repo/project",
        instructions: "Implement from the current chat thread.",
        origin: {
          triggerKind: "chat",
          channelId: "channel-1",
          threadId: "thread-1",
          messageId: "message-1",
        },
        reporting: { mode: "chat_thread" },
      },
    });

    expect(result).toMatchObject({
      taskId: "127ec051-d7cc-4218-a480-d6b4dd7e0d6d",
      workPlan: {
        taskId: "127ec051-d7cc-4218-a480-d6b4dd7e0d6d",
        reporting: { mode: "chat_thread" },
      },
    });
  });

  test("dispatch.ensureImplementationReviewTask preserves Flight Deck reporting mode when dispatch context exists", async () => {
    const result = await builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({
      dispatch: { routeId: "route-1" },
      workspace: { workspaceId: "workspace-1" },
      reporting: { mode: "pipeline_result" },
      taskId: "task-1",
      workPlan: {
        workdir: "/repo/project",
        instructions: "Implement from task.",
        designDocumentUrl: "flightdeck-task://task-1",
        targetSurface: { route: "/settings" },
      },
    });

    expect(result).toMatchObject({
      published: false,
      status: "not_configured",
      taskId: "task-1",
      taskBacked: true,
      workPlan: {
        taskId: "task-1",
        origin: { kind: "flightdeck_task" },
        reporting: { mode: "flightdeck_task" },
      },
      maxReviewIterations: 3,
      reviewLoop: {
        total: 3,
        done: false,
      },
    });
  });

  test("dispatch.ensureImplementationReviewTask carries explicit review loop limit", async () => {
    const result = await builtinPipelineFunctions["dispatch.ensureImplementationReviewTask"]!({
      maxReviewIterations: 5,
      workPlan: {
        workdir: "/repo/project",
        instructions: "Implement from task.",
        designDocumentUrl: "flightdeck-task://task-1",
        targetSurface: { route: "/settings" },
      },
    });

    expect(result).toMatchObject({
      maxReviewIterations: 5,
      reviewLoop: {
        iteration: 1,
        index: 0,
        completed: 0,
        total: 5,
        done: false,
      },
    });
  });

  test("dispatch.normaliseWorkPlanContext supports direct generic runs", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseWorkPlanContext"]!({
      workdir: "/repo/ops",
      instructions: "Write the operator handoff.",
      workPlan: {
        taskSummary: "Prepare a handoff",
        acceptanceCriteria: ["Handoff is written"],
      },
    });

    expect(result).toMatchObject({
      status: "ready",
      operation: "work-plan-context.normalise",
      taskBacked: false,
      workPlan: {
        taskSummary: "Prepare a handoff",
        origin: { kind: "direct" },
        workdir: "/repo/ops",
        instructions: "Write the operator handoff.",
        acceptanceCriteria: ["Handoff is written"],
        reporting: { mode: "pipeline_result" },
      },
      createdTask: {
        workPlan: {
          taskSummary: "Prepare a handoff",
          reporting: { mode: "pipeline_result" },
        },
      },
    });
  });

  test("dispatch.normaliseWorkPlanContext enables Flight Deck closeout for task dispatch", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseWorkPlanContext"]!({
      dispatch: { routeId: "route-1" },
      record: { recordId: "task-1" },
      taskId: "task-1",
      workPlan: {
        taskSummary: "Research options",
        workdir: "/repo/research",
        instructions: "Research the options.",
        reporting: { mode: "pipeline_result" },
      },
    });

    expect(result).toMatchObject({
      status: "not_configured",
      operation: "work-plan-context.normalise",
      taskId: "task-1",
      taskBacked: true,
      workPlan: {
        taskId: "task-1",
        taskSummary: "Research options",
        origin: { kind: "flightdeck_task" },
        reporting: { mode: "flightdeck_task" },
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskId: "task-1",
          reporting: { mode: "flightdeck_task" },
        },
      },
    });
  });

  test("dispatch.normaliseTaskWorkPlan normalises list fields", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "do_and_review",
        taskSummary: "Research a booking option.",
        initialFindings: ["Context loaded", ""],
        executionPlan: ["Check availability", "Report options"],
        managerChecklist: "Confirm sources",
        taskUpdatePlan: ["Comment after launch"],
        risks: ["Availability may change"],
        confidence: 0.8,
      },
      record: {
        payload: {
          title: "Book Kyoto museum tickets",
          description: "Research and recommend options.",
        },
      },
    });

    expect(result.workStyle).toBe("do_and_review");
    expect(result.childPipelineDefinitionId).toBe("do-and-review");
    expect(result.initialFindings).toEqual(["Context loaded"]);
    expect(result.managerChecklist).toEqual(["Confirm sources"]);
    expect(result.executionPlan).toEqual(["Check availability", "Report options"]);
  });

  test("dispatch.normaliseTaskWorkPlan honors explicit software routing for nested task payloads", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the rendered task links.",
        workdir: "/repo/app",
        targetSurface: {
          route: "/tasks",
          surface: "rendered task links",
          files: ["src/tasks.ts"],
        },
        confidence: 0.9,
      },
      record: {
        payload: {
          data: {
            title: "Ensure links click through",
            description: "Please send this to an implementation pipeline.",
          },
        },
      },
    });

    expect(result.workStyle).toBe("software_implementation");
    expect(result.childPipelineDefinitionId).toBe("software-implementation-review-loop");
    expect(result.launchable).toBe(true);
  });

  test("dispatch.normaliseTaskWorkPlan blocks software launch without a real repo and target surface", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the workspace avatar bug.",
        confidence: 0.9,
      },
      agent: { workingDirectory: "/srv/autopilot/data/agent-chat-workspaces/fd-private" },
      record: {
        recordId: "task-avatar",
        payload: {
          title: "The Workspace Avatar icon doesn't always load",
          description: "Review the task comments and implement the fix.",
        },
      },
    });

    expect(result.workStyle).toBe("software_implementation");
    expect(result.childPipelineDefinitionId).toBeNull();
    expect(result.launchable).toBe(false);
    expect(result.workdir).toBeNull();
    expect(result.missing).toEqual(["non-placeholder workdir", "targetSurface"]);
    expect(String(result.launchBlockedReason)).toContain("non-placeholder workdir, targetSurface");
  });

  test("dispatch.normaliseTaskWorkPlan infers explicit channel repo but still requires target surface", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the workspace avatar bug.",
        targetSurface: {
          route: "workspace profile / workspace avatar",
          surface: "workspace avatar storage visibility",
          files: ["src/workspace-manager.js"],
        },
        confidence: 0.9,
      },
      agent: { workingDirectory: "/srv/autopilot/data/agent-chat-workspaces/fd-private" },
      flightDeckContext: {
        channel: {
          id: "bugs",
          scopeId: "scope-1",
          name: "Bugs",
          contextPrompt: "This is the bugs channel of the Flight Deck project (/srv/code/wingmanbefree/wm-fd-2).",
          hasSpecificContext: true,
        },
      },
      record: {
        recordId: "task-avatar",
        payload: {
          title: "The Workspace Avatar icon doesn't always load",
          description: "Review the task comments and implement the fix.",
        },
      },
    });

    expect(result.childPipelineDefinitionId).toBe("software-implementation-review-loop");
    expect(result.launchable).toBe(true);
    expect(result.workdir).toBe("/srv/code/wingmanbefree/wm-fd-2");
    expect(result.missing).toEqual([]);
  });

  test("dispatch.normaliseTaskWorkPlan routes explicit research to research-and-report", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "research_and_report",
        taskSummary: "Research current API options and write a report.",
        confidence: 0.9,
      },
      record: {
        payload: {
          title: "Research API options",
          description: "Compare sources and produce a concise report.",
        },
      },
    });

    expect(result.workStyle).toBe("research_and_report");
    expect(result.childPipelineDefinitionId).toBe("research-and-report");
  });

  test("dispatch.normaliseTaskWorkPlan extracts PH1 ticket paths into software work plans", async () => {
    const ticketPath = "/srv/code/wingmanbefree/flightdeck-pg/implementation/phase1/ticket_ph1_2_typed_api_contract_fixtures.md";
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Implement PH1 typed API fixtures.",
      },
      record: {
        recordId: "task-ph1-2",
        payload: {
          task_id: "task-ph1-2",
          title: "PH1-2 typed API contract fixtures",
          description: `Implement this task.\nTicket: ${ticketPath}\nRun focused tests.`,
        },
      },
    });

    expect(result.childPipelineDefinitionId).toBeNull();
    expect(result.launchable).toBe(false);
    expect(result.missing).toEqual(["non-placeholder workdir", "targetSurface"]);
    expect(result.designDocumentUrl).toBe(ticketPath);
    expect(result.designDocumentSource).toBe("task_description");
    expect(result.designDocumentUnavailableReason).toBeUndefined();
  });

  test("dispatch.normaliseTaskWorkPlan extracts primary design artifact paths", async () => {
    const designPath = "/srv/code/wingmanbefree/autopilot/docs/design/pipeline-design-document-url-propagation.md";
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix pipeline propagation.",
      },
      record: {
        recordId: "task-design",
        payload: {
          title: "Pipeline propagation fix",
          description: `Primary design/ticket artifact: ${designPath}`,
        },
      },
    });

    expect(result.designDocumentUrl).toBe(designPath);
    expect(result.designDocumentSource).toBe("task_description");
  });

  test("dispatch.normaliseTaskWorkPlan uses a task-context fallback when no artifact exists", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskWorkPlan"]!({
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the API bug.",
        workdir: "/repo/app",
        targetSurface: {
          route: "/api",
          surface: "API bug",
          files: ["src/api.ts"],
        },
      },
      record: {
        recordId: "task-without-design",
        payload: {
          title: "Fix the API bug",
          description: "There is no separate design document for this small implementation task.",
        },
      },
    });

    expect(result.designDocumentUrl).toBe("flightdeck-task://task-without-design");
    expect(result.designDocumentSource).toBe("task_context_fallback");
    expect(result.designDocumentUnavailableReason).toBe("no_separate_design_or_ticket_artifact");
  });

  test("task intake propagates design references into child pipeline work plan input", async () => {
    const ticketPath = "/srv/code/wingmanbefree/flightdeck-pg/implementation/phase1/ticket_ph1_2_typed_api_contract_fixtures.md";
    const result = await runTaskDispatchSpec({
      taskDescription: `Implement PH1 work.\nTicket: ${ticketPath}`,
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Implement PH1 typed API fixtures.",
        workdir: "/srv/code/wingmanbefree/flightdeck-pg",
        targetSurface: {
          surface: "PH1 typed API fixtures",
          files: [ticketPath],
        },
        confidence: 0.9,
      },
      taskId: "task-ph1-2",
    });
    const startStep = taskAfterStep(result, "start-follow-up-pipeline");
    const childPipeline = startStep.childPipeline as JsonObject;
    const workPlan = childPipeline.workPlan as JsonObject;
    const childInputWorkPlan = childPipeline.childInputWorkPlan as JsonObject;

    expect(childPipeline.pipelineDefinitionId).toBe("software-implementation-review-loop");
    expect(workPlan.designDocumentUrl).toBe(ticketPath);
    expect(childInputWorkPlan.designDocumentUrl).toBe(ticketPath);
  });

  test("task intake skips child pipeline launch when software contract is incomplete", async () => {
    const result = await runTaskDispatchSpec({
      taskDescription: "Fix the workspace avatar bug.",
      agentResponse: {
        accepted: true,
        workStyle: "software_implementation",
        taskSummary: "Fix the workspace avatar bug.",
        confidence: 0.9,
      },
      taskId: "task-avatar",
    });
    const normaliseStep = taskAfterStep(result, "normalise-work-plan");
    const startStep = result.steps.find((step) => step.name === "start-follow-up-pipeline");

    expect(normaliseStep.workPlan).toMatchObject({
      launchable: false,
      childPipelineDefinitionId: null,
      missing: ["non-placeholder workdir", "targetSurface"],
    });
    expect(startStep?.status).toBe("skipped");
  });

  test("dispatch.prepareChatIntentInput compacts chat context for intent analysis", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: {
        workspaceOwnerNpub: "npub1owner",
        sourceAppNpub: "npub1source",
        backendBaseUrl: "https://example.invalid",
      },
      agent: {
        botNpub: "npub1bot",
        workingDirectory: "/repo",
        defaultAgent: "codex",
      },
      chat: {
        senderNpub: "npub1requester",
        channelId: "channel-1",
        threadId: "thread-1",
      },
      record: {
        recordId: "message-1",
        payload: { sender_npub: "npub1payload" },
      },
      runtime: {
        commandPrefix: "do not pass this through",
        availablePipelines: [
          {
            id: "shared:63d40fd2a6c3",
            slug: "agent-dispatch-chat",
            name: "agent-dispatch-chat",
            description: "Dispatch pipeline",
          },
          {
            id: "shared:b7c038e9cf55",
            slug: "research-and-report",
            name: "research-and-report",
            scope: "shared",
            description: "Long-running research pipeline.",
          },
          {
            id: "shared:90e8752d9b94",
            slug: "agent-dispatch-comment-response",
            name: "agent-dispatch-comment-response",
            scope: "shared",
            description: "Comment dispatch pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        selfAuthored: false,
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              sender_npub: "npub1requester",
              body: "Please research this and write a report.",
              updated_at: "2026-05-12T00:00:00.000Z",
            },
          ],
        },
        scopes: [
          {
            record_id: "scope-1",
            title: "Marketing",
            level: "l1",
            group_ids: ["not-needed"],
            updated_at: "2026-05-12T00:00:00.000Z",
          },
        ],
        referencedRecords: [
          {
            recordId: "doc-1",
            recordFamily: "document",
            payload: {
              title: "Reference doc",
              body: "Useful context",
            },
          },
        ],
      },
    });

    expect(result).toMatchObject({
      source: {
        routeId: "route-1",
        requesterNpub: "npub1requester",
      },
      defaults: {
        workdir: "/repo",
        assignerNpub: "npub1requester",
        reviewerNpub: "npub1requester",
      },
      latestThread: [
        {
          messageId: "message-1",
          body: "Please research this and write a report.",
        },
      ],
      scopes: [
        {
          id: "scope-1",
          title: "Marketing",
          level: "l1",
        },
      ],
    });
    expect(result).not.toHaveProperty("validChildPipelines");
    expect(result.notes).toContain("Classify only as answer_now, think_then_answer, create_task, or ignore.");
    expect(JSON.stringify(result)).not.toContain("commandPrefix");
    expect(JSON.stringify(result)).not.toContain("group_ids");
    expect(JSON.stringify(result)).not.toContain("l1_id");
    expect(JSON.stringify(result)).not.toContain("research-and-report");
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-comment-response");
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-chat");
  });

  test("workroom role metadata changes the intent packet while normal chat stays compact", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-workroom", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { botNpub: "npub1bot", workingDirectory: "/repo" },
      chat: { messageText: "Review the PR", senderNpub: "npub1requester", channelId: "channel-1", threadId: "root-1" },
      record: { recordId: "message-1", payload: { body: "Review the PR", sender_npub: "npub1requester" } },
      chatContext: { shouldProceed: true, thread: { recent_messages: [{ message_id: "message-1", body: "Review the PR" }] } },
      workroomContext: {
        isWorkroom: true,
        workroom: { id: "room-1", goal: "Ship the release", state: "active", repo: { integrationBranch: "staging" } },
        participant: { role: "reviewer", capabilities: ["github_pr"] },
        appTargets: [{ kind: "preview", runbook: { test: "bun test" } }],
        recentEvents: [{ eventType: "pr_ready" }],
        recentLinks: [],
        openApprovals: [],
      },
    });
    expect(result.workroomContext).toMatchObject({ participant: { role: "reviewer" } });
    expect(result.workroomInstruction).toContain("reviewer");
    expect(result.notes.join(" ")).toContain("typed workroom fields");

    const normal = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-normal", triggerKind: "chat" },
      workspace: {}, agent: {}, chat: { senderNpub: "npub1requester" }, record: { recordId: "message-2", payload: {} },
      chatContext: { shouldProceed: true, thread: { recent_messages: [{ message_id: "message-2", body: "Hello" }] } },
    });
    expect(normal).not.toHaveProperty("workroomInstruction");
    expect(normal).not.toHaveProperty("workroomContext");
  });

  test("workroom participant self-fill produces structured metadata", async () => {
    const result = await builtinPipelineFunctions["workroom.prepareParticipantMetadata"]!({
      workroomContext: { isWorkroom: true, workroom: { id: "room-1" } },
      agent: { workingDirectory: "/repo", capabilities: ["github_pr", "tests"], canRunTests: true },
      runtime: { mode: "flightdeck_pg" },
    });
    expect(result).toEqual({
      isWorkroom: true,
      metadata: {
        repoPath: "/repo",
        defaultBranch: "main",
        capabilities: ["github_pr", "tests"],
        localApps: [],
        constraints: {},
        canRunTests: true,
        runtime: "flightdeck_pg",
      },
      status: "structured",
      workroomId: "room-1",
    });
  });

  test("dispatch.prepareChatIntentInput appends the triggering chat message when hydration is stale", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: {
        botNpub: "npub1bot",
        workingDirectory: "/repo",
        defaultAgent: "codex",
      },
      chat: {
        messageText: "Excellent that works consistently now",
        senderNpub: "npub1requester",
        channelId: "channel-1",
        threadId: "thread-1",
        parentMessageId: "thread-1",
      },
      record: {
        recordId: "message-3",
        updaterNpub: "npub1requester",
        payload: {
          record_id: "message-3",
          parent_message_id: "thread-1",
          body: "Excellent that works consistently now",
          sender_npub: "npub1requester",
          updated_at: "2026-06-01T11:58:06.893Z",
        },
      },
      runtime: {
        availablePipelines: [
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        thread: {
          recent_messages: [
            {
              message_id: "thread-1",
              sender_npub: "npub1requester",
              body: "Please fix the chat scroll behavior.",
              updated_at: "2026-06-01T09:20:26.675Z",
            },
            {
              message_id: "message-2",
              parent_message_id: "thread-1",
              sender_npub: "npub1bot",
              body: "Done: the pipeline work is ready for review.",
              updated_at: "2026-06-01T09:32:06.649Z",
            },
          ],
        },
      },
    });

    expect(result.source).toMatchObject({
      messageId: "message-3",
      requesterNpub: "npub1requester",
    });
    expect(result.latestThread).toEqual([
      {
        messageId: "thread-1",
        parentMessageId: null,
        senderNpub: "npub1requester",
        body: "Please fix the chat scroll behavior.",
        attachments: [],
        updatedAt: "2026-06-01T09:20:26.675Z",
      },
      {
        messageId: "message-2",
        parentMessageId: "thread-1",
        senderNpub: "npub1bot",
        body: "Done: the pipeline work is ready for review.",
        attachments: [],
        updatedAt: "2026-06-01T09:32:06.649Z",
      },
      {
        messageId: "message-3",
        parentMessageId: "thread-1",
        senderNpub: "npub1requester",
        body: "Excellent that works consistently now",
        attachments: [],
        updatedAt: "2026-06-01T11:58:06.893Z",
      },
    ]);
  });

  test("dispatch.prepareDocumentDiscussionContext compacts chat and runtime context", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareDocumentDiscussionContext"]!({
      dispatch: { routeId: "route-doc", triggerKind: "chat" },
      workspace: {
        workspaceOwnerNpub: "npub1service",
        humanWorkspaceOwnerNpub: "npub1owner",
        workspaceId: "workspace-1",
        sourceAppNpub: "npub1app",
        backendBaseUrl: "https://tower.example",
      },
      agent: {
        botNpub: "npub1bot",
        workingDirectory: "/repo",
        defaultAgent: "codex",
      },
      chat: {
        senderNpub: "npub1requester",
        channelId: "channel-1",
        threadId: "thread-1",
      },
      record: {
        recordId: "message-2",
        payload: {
          sender_npub: "npub1requester",
          body: "Please review the inline comments in @[Doc](mention:document:doc-1).",
        },
      },
      routing: { channelId: "channel-1", threadId: "thread-1" },
      runtime: {
        mode: "flightdeck_pg",
        commandPrefix: "do not pass this through",
        availablePipelines: Array.from({ length: 40 }, (_, index) => ({
          id: `pipeline-${index}`,
          slug: `pipeline-${index}`,
          description: "Large catalog entry".repeat(100),
        })),
      },
      decision: {
        intent: "document_discussion",
        recommendedPipelineId: "document-discussion",
        chatResponse: { body: "I'll review the document." },
      },
      workPlan: {
        taskSummary: "Review feature doc",
        originalPrompt: "Please review the inline comments.",
        origin: { channelId: "channel-1", threadId: "thread-1", messageId: "message-2" },
      },
      chatContext: {
        shouldProceed: true,
        selfAuthored: false,
        channelContext: {
          channelId: "channel-1",
          contextPrompt: "Features should be developed in a Flight Deck document.",
        },
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              sender_npub: "npub1requester",
              body: "Here is the doc: https://example.invalid/docs?docid=doc-1",
              updated_at: "2026-06-15T00:00:00.000Z",
            },
            {
              message_id: "message-2",
              sender_npub: "npub1requester",
              body: "Please review the inline comments in @[Doc](mention:document:doc-1).",
              updated_at: "2026-06-15T00:01:00.000Z",
            },
          ],
        },
        referencedRecords: [{
          recordId: "doc-1",
          recordFamily: "document",
          payload: {
            title: "Feature doc",
            body: "Long body".repeat(5000),
          },
        }],
      },
    });

    expect(result).toMatchObject({
      source: {
        routeId: "route-doc",
        channelId: "channel-1",
        threadId: "thread-1",
        messageId: "message-2",
      },
      runtime: { mode: "flightdeck_pg", error: null },
      latestThread: [
        expect.objectContaining({ messageId: "message-1" }),
        expect.objectContaining({ messageId: "message-2" }),
      ],
      referencedRecords: [
        expect.objectContaining({
          recordId: "doc-1",
          family: "document",
          title: "Feature doc",
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain("availablePipelines");
    expect(JSON.stringify(result)).not.toContain("commandPrefix");
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(250000);
  });

  test("shared document-discussion definition loads thread, document/comments, updates, reviews, asks, and publishes", () => {
    const spec = loadSharedPipelineSpec("document-discussion.json");
    expect(spec.name).toBe("document-discussion");
    expect(spec.steps.map((step) => step.name)).toEqual([
      "reload-thread",
      "compact-document-discussion-context",
      "load-document-and-comments",
      "ensure-discussion-document",
      "update-document",
      "review-document-against-goal",
      "draft-next-question",
      "publish-document-discussion-reply",
    ]);
  });

  test("shared fd-document-invocation definition loads document, lets agent edit, and publishes summary", () => {
    const spec = loadSharedPipelineSpec("fd-document-invocation.json");
    expect(spec.name).toBe("fd-document-invocation");
    expect(spec.steps.map((step) => step.name)).toEqual([
      "prepare-document-invocation-context",
      "handle-document-invocation",
      "publish-document-invocation-summary",
    ]);
    expect(spec.steps[0]).toMatchObject({
      type: "code",
      function: "dispatch.prepareDocumentInvocationContext",
    });
    expect(spec.steps[2]).toMatchObject({
      type: "code",
      function: "dispatch.publishDocumentInvocationSummary",
    });
  });

  test("document invocation dispatch functions are dry-run outside dispatch routes", async () => {
    const prepared = await builtinPipelineFunctions["dispatch.prepareDocumentInvocationContext"]!({
      record: {
        payload: {
          invocation_id: "invocation-1",
          prompt: "Review this doc.",
          target_id: "doc-1",
        },
      },
    });
    expect(prepared).toMatchObject({
      status: "not_configured",
      operation: "docs.prepare-document-invocation",
    });

    const published = await builtinPipelineFunctions["dispatch.publishDocumentInvocationSummary"]!({
      agentResult: { summary: "Updated the document." },
    });
    expect(published).toMatchObject({
      published: false,
      status: "not_configured",
      operation: "docs.publish-document-invocation-summary",
    });
  });

  test("shared fd-task-invocation definition loads task, classifies work, launches child work, and comments on task", () => {
    const spec = loadSharedPipelineSpec("fd-task-invocation.json");
    expect(spec.name).toBe("fd-task-invocation");
    expect(spec.steps.map((step) => step.name)).toEqual([
      "prepare-task-invocation-context",
      "classify-task-invocation",
      "normalise-task-invocation-plan",
      "start-task-child-pipeline",
      "publish-task-invocation-response",
    ]);
    expect(spec.steps[0]).toMatchObject({
      type: "code",
      function: "dispatch.prepareTaskInvocationContext",
    });
    expect(spec.steps[2]).toMatchObject({
      type: "code",
      function: "dispatch.normaliseTaskInvocationPlan",
    });
    expect(spec.steps[4]).toMatchObject({
      type: "code",
      function: "dispatch.publishTaskInvocationResponse",
    });
  });

  test("task invocation normaliser routes software work to task-backed implementation loop", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseTaskInvocationPlan"]!({
      invocationContext: {
        invocation: {
          invocationId: "invocation-1",
          prompt: "Please implement the padding fix.",
          requesterNpub: "npub1requester",
        },
        location: {
          scopeId: "scope-1",
          channelId: "channel-1",
        },
        task: {
          taskId: "task-1",
          title: "Fix padding",
          description: "The dashboard cards need tighter padding.",
        },
      },
      agentResponse: {
        accepted: true,
        action: "start_pipeline",
        workStyle: "software_implementation",
        taskSummary: "Implement the dashboard padding fix",
        instructions: "Make the padding match the design and add focused validation.",
        workdir: "/repo/app",
        targetSurface: {
          route: "/dashboard",
          surface: "cards",
          files: ["src/dashboard/Card.tsx"],
        },
      },
    });

    expect(result).toMatchObject({
      action: "start_pipeline",
      shouldStartChild: true,
      shouldComment: true,
      taskId: "task-1",
      childPipelineDefinitionId: "software-implementation-review-loop",
      workPlan: {
        taskId: "task-1",
        taskTitle: "Fix padding",
        taskSummary: "Implement the dashboard padding fix",
        instructions: "Make the padding match the design and add focused validation.",
        originalPrompt: "Please implement the padding fix.",
        workdir: "/repo/app",
        origin: {
          kind: "flightdeck_task",
          triggerKind: "task",
          taskId: "task-1",
          channelId: "channel-1",
          messageId: "invocation-1",
        },
        reporting: {
          mode: "flightdeck_task",
        },
      },
    });
  });

  test("task invocation dispatch functions are dry-run outside dispatch routes", async () => {
    const prepared = await builtinPipelineFunctions["dispatch.prepareTaskInvocationContext"]!({
      record: {
        payload: {
          invocation_id: "invocation-1",
          prompt: "Review this task.",
          target_id: "task-1",
        },
      },
    });
    expect(prepared).toMatchObject({
      status: "not_configured",
      operation: "tasks.prepare-task-invocation",
    });

    const published = await builtinPipelineFunctions["dispatch.publishTaskInvocationResponse"]!({
      plan: { taskComment: "Updated the task." },
    });
    expect(published).toMatchObject({
      published: false,
      status: "not_configured",
      operation: "tasks.publish-task-invocation-response",
    });
  });

  test("dispatch.prepareChatDispatchResponse replies when task creation fails", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        responseDraft: "Starting work.",
        confidence: 0.8,
      },
      createdTask: {
        status: "failed",
        reason: "fetch failed",
        workPlan: {
          taskSummary: "Fix dispatch",
        },
      },
      childPipeline: {
        started: false,
        status: "failed",
        reason: "No child pipeline definition id was provided.",
      },
    });

    expect(result).toMatchObject({
      shouldRespond: true,
      reasoningSummary: "Task-backed dispatch was requested, but task creation failed; reporting the issue in chat.",
    });
    expect(result.responseDraft).toContain("could not create the Flight Deck task");
    expect(result.responseDraft).toContain("fetch failed");
    expect(result.actionsTaken).toContain("task creation failed: fetch failed");
  });

  test("dispatch.prepareChatIntentInput accepts wrapped scope list payloads", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatIntentInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", payload: {} },
      runtime: {
        availablePipelines: [
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              body: "Please handle this generic image task.",
            },
          ],
        },
        scopes: {
          scopes: [
            {
              id: "scope-1",
              title: "Big Dawgs",
              level: "workspace",
            },
          ],
        },
      },
    });

    expect(result.scopes).toEqual([
      {
        id: "scope-1",
        title: "Big Dawgs",
        level: "workspace",
        parentId: null,
      },
    ]);
    expect(result).not.toHaveProperty("validChildPipelines");
    expect(result.notes).toContain("Use create_task only for durable output such as code, docs, files, WApp changes, migrations, configuration, or other concrete artifacts.");
  });

  test("dispatch.prepareChatTaskPipelineInput loads task pipeline candidates after create_task", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatTaskPipelineInput"]!({
      dispatch: { routeId: "route-1", triggerKind: "chat" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1source" },
      agent: { workingDirectory: "/repo", defaultAgent: "codex" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", payload: { body: "Please implement the fix." } },
      runtime: {
        availablePipelines: [
          {
            id: "shared:agent-dispatch-chat",
            slug: "agent-dispatch-chat",
            name: "agent-dispatch-chat",
            scope: "shared",
          },
          {
            id: "shared:fd-agent-dispatch-chat",
            slug: "fd-agent-dispatch-chat",
            name: "fd-agent-dispatch-chat",
            scope: "shared",
          },
          {
            id: "user:exampleAgent-agent-dispatch-chat.v4",
            slug: "exampleAgent-agent-dispatch-chat.v4",
            name: "exampleAgent-agent-dispatch-chat",
            scope: "user",
          },
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
          {
            id: "shared:impl",
            slug: "software-implementation-review-loop",
            name: "software-implementation-review-loop",
            scope: "shared",
            description: "Implementation review pipeline.",
          },
        ],
      },
      chatContext: {
        shouldProceed: true,
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              body: "Please implement the fix.",
            },
          ],
        },
      },
      decision: {
        intent: "create_task",
        taskDraft: {
          title: "Implement fix",
          instructions: "Change code and run tests.",
        },
      },
    });

    expect(result.validChildPipelines).toEqual([
      {
        id: "shared:12b50cd8ba58",
        slug: "do-and-review",
        name: "do-and-review",
        scope: "shared",
        description: "Generic delivery pipeline.",
      },
      {
        id: "shared:impl",
        slug: "software-implementation-review-loop",
        name: "software-implementation-review-loop",
        scope: "shared",
        description: "Implementation review pipeline.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("agent-dispatch-chat");
    expect(JSON.stringify(result)).not.toContain("fd-agent-dispatch-chat");
    expect(JSON.stringify(result)).not.toContain("exampleAgent-agent-dispatch-chat");
  });

  test("dispatch.normaliseChatTaskPipelineSelection enables create_task after task pipeline selection", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatTaskPipelineSelection"]!({
      decision: {
        requestedDispatchTask: true,
        taskRoutingPending: true,
        taskDraft: {
          title: "Handle the image task",
          instructions: "Complete the generic image task.",
          acceptanceCriteria: ["The requested image task is complete"],
        },
        workPlan: {
          taskSummary: "Handle the image task",
          instructions: "Complete the generic image task.",
          workdir: "/repo",
        },
        responseDraft: "Starting a generic task.",
      },
      taskPipelineInput: {
        validChildPipelines: [
          {
            id: "shared:12b50cd8ba58",
            slug: "do-and-review",
            name: "do-and-review",
            scope: "shared",
            description: "Generic delivery pipeline.",
          },
        ],
      },
      taskPipelineDecision: {
        recommendedPipelineId: "do-and-review",
        workdir: "/repo",
        confidence: 0.8,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: true,
      pipelineDefinitionId: "shared:12b50cd8ba58",
      taskRoutingPending: false,
      missing: [],
      responseDraft: "Starting a generic task.",
    });
    expect(result.workPlan).toMatchObject({
      pipelineDefinitionId: "shared:12b50cd8ba58",
      childPipelineDefinitionId: "shared:12b50cd8ba58",
      workdir: "/repo",
    });
  });

  test("legacy dispatchTask decisions without pipeline stay pending for task selection", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        intent: "create_task",
        dispatchTask: true,
        taskDraft: {
          title: "Handle the image task",
          instructions: "Complete the generic image task.",
          acceptanceCriteria: ["The requested image task is complete"],
        },
        chatResponse: { body: "Starting a generic task." },
        confidence: 0.8,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      requestedDispatchTask: true,
      intent: "create_task",
      pipelineDefinitionId: null,
      taskRoutingPending: true,
      responseDraft: "Starting a generic task.",
    });
  });

  test("create_task decisions with concreteInstructions stay pending for task selection", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        intent: "create_task",
        dispatchTask: true,
        taskDraft: {
          title: "Create planning threads",
          concreteInstructions: "Create one Flight Deck thread per refactor area.",
          acceptanceCriteria: ["The planning threads are created"],
        },
        chatResponse: { body: "" },
        confidence: 0.94,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      requestedDispatchTask: true,
      intent: "create_task",
      taskRoutingPending: true,
      taskDraft: {
        instructions: "Create one Flight Deck thread per refactor area.",
      },
      workPlan: {
        instructions: "Create one Flight Deck thread per refactor area.",
      },
    });
  });

  test("shared agent-dispatch-chat definition keeps initial chat lifecycle narrow", () => {
    const spec = loadSharedPipelineSpec("agent-dispatch-chat.json");
    const names = spec.steps.map((step) => step.name);
    expect(names).toEqual([
      "prepare-workroom-participant-metadata",
      "hydrate-chat-context",
      "prepare-intent-input",
      "prepare-short-lookup-answer",
      "analyse-intent",
      "normalise-decision",
      "dispatch-agent",
      "normalise-agent-work-decision",
      "route-discussion-chat",
      "prepare-task-pipeline-input",
      "select-task-pipeline",
      "normalise-task-pipeline-selection",
      "create-in-progress-task",
      "start-selected-pipeline",
      "start-required-pipelines",
      "start-direct-pipeline",
      "reload-chat-thread-before-reply",
      "mark-response-drafting",
      "prepare-chat-response",
      "publish-chat-response",
    ]);
    const functions = spec.steps.map((step) => step.type === "code" ? step.function : null).filter(Boolean);
    expect(functions).not.toContain("dispatch.detectChatReviewApproval");
    expect(functions).not.toContain("dispatch.completeReviewTaskFromChat");
    expect(functions).not.toContain("dispatch.blockTaskIfPipelineLaunchFailed");
    expect(functions).toContain("dispatch.routeDiscussionChat");
    expect(functions).toContain("dispatch.prepareShortLookupAnswer");
    expect(functions).toContain("dispatch.normaliseChatAgentWorkDecision");
    expect(functions).toContain("dispatch.prepareChatTaskPipelineInput");
    expect(functions).toContain("dispatch.normaliseChatTaskPipelineSelection");
    expect(spec.steps.find((step) => step.name === "analyse-intent")).toMatchObject({
      type: "classifier",
      provider: "openrouter",
      model: "openai/gpt-oss-120b:nitro",
      retries: 3,
    });
    expect(spec.steps.map((step) => step.name)).not.toContain("mark-response-thinking");
    expect(spec.steps.find((step) => step.name === "mark-response-drafting")).toMatchObject({
      type: "code",
      input: {
        value: {
          status: "drafting",
          label: "Writing a reply",
          expiresInSeconds: 90,
        },
      },
    });
    expect(spec.steps.find((step) => step.name === "dispatch-agent")).toMatchObject({
      type: "agent",
      when: { path: "$.decision.dispatchAgent", equals: true },
    });
    expect(String(spec.steps.find((step) => step.name === "dispatch-agent")?.prompt)).toContain("channelContext.contextPrompt as high-information channel/project policy");
    expect(String(spec.steps.find((step) => step.name === "dispatch-agent")?.prompt)).toContain("final output should still be a chat reply");
    expect(String(spec.steps.find((step) => step.name === "dispatch-agent")?.prompt)).toContain("Do not choose child pipelines in this step");
    expect(String(spec.steps.find((step) => step.name === "analyse-intent")?.prompt)).toContain("answer_now|think_then_answer|create_task|ignore");
    expect(spec.steps.find((step) => step.name === "select-task-pipeline")).toMatchObject({
      type: "classifier",
      when: { path: "$.decision.taskRoutingPending", equals: true },
    });

    const prepare = spec.steps.find((step) => step.name === "prepare-chat-response");
    expect(prepare?.input).toEqual({
      pick: {
        decision: "$.decision",
        createdTask: "$.createdTask",
        childPipeline: "$.childPipeline",
        childPipelines: "$.childPipelines",
        closeoutContext: "$.closeoutContext",
      },
    });
  });

  test("software implementation loop reads normalised review loop context", async () => {
    const definition = await getPipelineDefinition("software-implementation-review-loop", "functions-test");
    if (!definition) throw new Error("software-implementation-review-loop definition missing");
    const spec = definition.spec;
    const loop = spec.steps.find((step) => step.name === "loop-to-implementation-worker");
    expect(loop).toMatchObject({
      type: "loop",
      iterations: "$.createdTask.maxReviewIterations",
      counter: "$.createdTask.reviewLoop",
    });
    expect(JSON.stringify(spec)).toContain("$.createdTask.reviewLoop");
    expect(JSON.stringify(spec)).toContain("runtimeUpdate");
    expect(JSON.stringify(spec)).toContain("runtimeReview");
    expect(spec.steps.find((step) => step.name === "final-chat-thread-response")).toMatchObject({
      type: "agent",
      when: { path: "$.createdTask.workPlan.reporting.mode", equals: "chat_thread" },
    });
    expect(spec.steps.find((step) => step.name === "publish-final-chat-response")).toMatchObject({
      type: "code",
      function: "dispatch.publishFlightDeckResponse",
      when: { path: "$.createdTask.workPlan.reporting.mode", equals: "chat_thread" },
    });
  });

  test("shared chat dispatch routes feature doc iteration to document discussion without task", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "I would like to review the Flight Deck summary page. Use this as the next feature definition iteration.",
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Features",
        contextPrompt: "When we are discussing features we are not trying to build them, we want to iterate on them and develop a doc. Each thread will be a new feature. We can create a Flight Deck doc to work on this feature definition. Post the Flight Deck Doc to the channel. Each new message should be treated as an iteration on this chat thread and the Flight Deck document.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "create_task",
        dispatchTask: true,
        taskDraft: {
          title: "Define Flight Deck summary page redesign",
          instructions: "Create or update the Flight Deck feature document for this thread and post the document link back to chat.",
          acceptanceCriteria: ["A Flight Deck document exists or is updated."],
        },
        chatResponse: { body: "" },
        confidence: 0.94,
      },
    });

    const routed = currentAfterStep(execution, "route-discussion-chat").decision as JsonObject;
    expect(routed).toMatchObject({
      dispatchTask: false,
      dispatchPipeline: true,
      requestedDispatchTask: false,
      dispatchDiscussion: true,
      taskRoutingPending: false,
      pipelineDefinitionId: "document-discussion",
      discussionPipelineDefinitionId: "document-discussion",
    });
    expect(currentAfterStep(execution, "prepare-task-pipeline-input").taskPipelineInput).toBeUndefined();
    expect(currentAfterStep(execution, "create-in-progress-task").createdTask).toBeUndefined();
    expect(currentAfterStep(execution, "start-direct-pipeline").childPipeline).toMatchObject({
      started: true,
      pipelineDefinitionId: "document-discussion",
    });
  });

  test("shared chat dispatch submits referenced document to document discussion child pipeline", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: 'Can you quickly review the doc "Adapt - Kindling Feedback" in this scope?',
      referencedRecords: [
        {
          type: "document",
          family: "document",
          id: "pg-doc-adapt-feedback",
          recordId: "pg-doc-adapt-feedback",
          title: "Adapt - Kindling Feedback",
          summary: "Kindling feedback notes",
        },
      ],
      agentDecision: {
        intent: "document_discussion",
        dispatchTask: false,
        recommendedPipelineId: "document-discussion",
        chatResponse: { body: "I'll review the document." },
        confidence: 0.9,
      },
    });

    const routed = currentAfterStep(execution, "route-discussion-chat").decision as JsonObject;
    const workPlan = routed.discussionWorkPlan as JsonObject;
    expect(workPlan.documentReference).toMatchObject({
      id: "pg-doc-adapt-feedback",
      recordId: "pg-doc-adapt-feedback",
      type: "document",
      title: "Adapt - Kindling Feedback",
    });
    expect(workPlan.referencedRecords).toEqual([
      expect.objectContaining({
        id: "pg-doc-adapt-feedback",
        type: "document",
        family: "document",
        title: "Adapt - Kindling Feedback",
      }),
    ]);
    expect(currentAfterStep(execution, "start-direct-pipeline").childPipeline).toMatchObject({
      started: true,
      pipelineDefinitionId: "document-discussion",
      workPlan: {
        documentReference: {
          id: "pg-doc-adapt-feedback",
          recordId: "pg-doc-adapt-feedback",
          type: "document",
          title: "Adapt - Kindling Feedback",
        },
      },
    });
  });

  test("shared chat dispatch keeps implement-doc requests on software task routing", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Can you implement @[Design for Autopilot Overview](mention:doc:76ebf6ac-91ff-47e2-af36-b99d47a10d57)",
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Features",
        contextPrompt: "When we are discussing features we are not trying to build them, we want to iterate on them and develop a doc. Each thread will be a new feature. We can create a Flight Deck doc to work on this feature definition. Post the Flight Deck Doc to the channel. Each new message should be treated as an iteration on this chat thread and the Flight Deck document.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: true,
        taskDraft: {
          title: "Implement Design for Autopilot Overview",
          instructions: "Implement the referenced Flight Deck document @[Design for Autopilot Overview](mention:doc:76ebf6ac-91ff-47e2-af36-b99d47a10d57) for the Flight Deck project in /srv/code/wingmanbefree/wm-fd-2.",
          acceptanceCriteria: ["The referenced design document is implemented in wm-fd-2."],
          executionPlan: ["Read the design document.", "Implement the scoped code changes.", "Run validation."],
          managerChecklist: ["Confirm the design is implemented."],
        },
        workPlan: {
          taskSummary: "Implement Design for Autopilot Overview",
          instructions: "Implement the referenced Flight Deck document for the Flight Deck project.",
          workdir: "/srv/code/wingmanbefree/wm-fd-2",
          targetSurface: {
            route: "/flight-deck",
            surface: "Flight Deck overview",
            existingFiles: ["index.html", "src/app.js", "src/styles.css"],
            forbidden: ["new top-level /autopilot page"],
          },
          designDocument: {
            sourceRef: "mention:doc:76ebf6ac-91ff-47e2-af36-b99d47a10d57",
            localPath: "/srv/code/wingmanbefree/wm-fd-2/tmp/design-autopilot-overview.md",
          },
        },
        chatResponse: { body: "Starting the software implementation task." },
        confidence: 0.93,
      },
    });

    const normalised = currentAfterStep(execution, "normalise-decision").decision as JsonObject;
    const routed = currentAfterStep(execution, "route-discussion-chat").decision as JsonObject;
    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(normalised).toMatchObject({
      dispatchAgent: true,
      intent: "agent",
    });
    expect(routed).toMatchObject({
      requestedDispatchTask: true,
      taskRoutingPending: false,
      intent: "create_task",
    });
    expect(routed.dispatchDiscussion).not.toBe(true);
    expect(result.createdTask).toMatchObject({ taskId: "task-created" });
    expect(result.childPipeline).toMatchObject({
      pipelineDefinitionId: "software-implementation-review-loop",
    });
    expect(result.decision).toMatchObject({
      dispatchTask: true,
      taskRoutingPending: false,
      pipelineDefinitionId: "software-implementation-review-loop",
      workdir: "/srv/code/wingmanbefree/wm-fd-2",
    });
  });

  test("shared chat dispatch derives software workdir from channel context before private agent workspace", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please build the feature in the linked doc.",
      agent: {
        workingDirectory: "/srv/code/wingmanbefree/autopilot/data/agent-chat-workspaces/fd-private",
        defaultAgent: "codex",
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "This is the Implementation channel scope for the Wingman Autopilot project (/srv/code/wingmanbefree/autopilot). Use the software-implementation-review-loop for implementation.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: true,
        taskDraft: {
          title: "Build linked feature",
          instructions: "Build the linked feature.",
          acceptanceCriteria: ["Feature is implemented."],
          executionPlan: ["Inspect", "Implement", "Validate"],
          managerChecklist: ["Check route"],
        },
        workPlan: {
          taskSummary: "Build linked feature",
          instructions: "Build the linked feature.",
          targetSurface: {
            route: "/docs",
            surface: "Docs",
            existingFiles: ["src/ui/app.js"],
          },
          designDocumentUrl: "/srv/code/wingmanbefree/autopilot/tmp/flightdeck-docs/docs-header.md",
        },
        confidence: 0.91,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(result.decision).toMatchObject({
      dispatchTask: true,
      pipelineDefinitionId: "software-implementation-review-loop",
      workdir: "/srv/code/wingmanbefree/autopilot",
    });
    expect(result.createdTask).toMatchObject({
      workPlan: {
        workdir: "/srv/code/wingmanbefree/autopilot",
        maxReviewIterations: 3,
      },
    });
  });

  test("shared chat dispatch does not advertise archived wingman checkout as software default", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please implement the Tiptap design spec as the new docs editor.",
      agent: {
        workingDirectory: "/srv/autopilot/data/agent-chat-workspaces/fd-private",
        defaultAgent: "codex",
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "This is the Implementation channel scope for the Flight Deck project (/srv/code/wingmanbefree/wm-fd-2).",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: true,
        taskDraft: {
          title: "Implement Tiptap docs editor",
          instructions: "Implement the Tiptap docs editor design.",
          acceptanceCriteria: ["The docs editor is implemented."],
        },
        workPlan: {
          taskSummary: "Implement Tiptap docs editor",
          instructions: "Implement the Tiptap docs editor design.",
          targetSurface: {
            route: "/docs",
            surface: "Docs editor",
          },
          designDocumentUrl: "@[Tiptap Design Spec](mention:doc:79b6684f-b5c6-4bb7-8deb-0d6b6c905d05)",
        },
        confidence: 0.91,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(result.decision).toMatchObject({
      dispatchTask: true,
      pipelineDefinitionId: "software-implementation-review-loop",
      workdir: "/srv/code/wingmanbefree/wm-fd-2",
    });
  });

  test("chat task pipeline input hides archived wingman checkout defaults", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatTaskPipelineInput"]!({
      dispatch: { triggerKind: "chat", routeId: "route-1" },
      workspace: { workspaceOwnerNpub: "npub1owner", sourceAppNpub: "npub1app" },
      agent: {
        workingDirectory: "/srv/autopilot/data/agent-chat-workspaces/fd-private",
        defaultAgent: "codex",
      },
      chat: {
        channelId: "channel-1",
        threadId: "thread-1",
      },
      record: {
        recordId: "message-1",
        payload: {
          body: "Please implement the Tiptap design spec.",
        },
      },
      runtime: {
        availablePipelines: [
          {
            id: "shared:software",
            slug: "software-implementation-review-loop",
            name: "software-implementation-review-loop",
            scope: "shared",
          },
        ],
      },
      chatContext: {
        messages: [
          { id: "message-1", body: "Please implement the Tiptap design spec." },
        ],
        channelContext: {
          contextPrompt: "This is the Implementation channel scope for the Flight Deck project (/srv/code/wingmanbefree/wm-fd-2).",
          hasSpecificContext: true,
        },
      },
      decision: {
        intent: "create_task",
        taskDraft: {
          title: "Implement Tiptap docs editor",
          instructions: "Implement the Tiptap docs editor design.",
        },
      },
    });

    expect(result.defaults).toMatchObject({
      workdir: "/srv/code/wingmanbefree/wm-fd-2",
    });
    expect(result.defaults).not.toMatchObject({
      workdir: "/srv/autopilot/data/agent-chat-workspaces/fd-private",
    });
  });

  test("shared chat dispatch direct software run gets chat-thread design reference", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please make the focused docs route fix in this repo.",
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "This is the Implementation channel scope for the Wingman Autopilot project (/srv/code/wingmanbefree/autopilot). Use software-implementation-review-loop for implementation.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: false,
        workPlan: {
          taskSummary: "Fix docs route",
          instructions: "Make the focused docs route fix described in the current chat thread.",
          targetSurface: {
            route: "/docs",
            existingFiles: ["src/app.js"],
          },
        },
        confidence: 0.91,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(result.decision).toMatchObject({
      dispatchTask: false,
      dispatchPipeline: true,
      pipelineDefinitionId: "software-implementation-review-loop",
      workdir: "/srv/code/wingmanbefree/autopilot",
      workPlan: {
        designDocumentUrl: expect.stringMatching(/^flightdeck-chat-thread:\/\/thread-1#message-/),
        reporting: { mode: "chat_thread" },
      },
    });
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toMatchObject({
      started: true,
      pipelineDefinitionId: "software-implementation-review-loop",
    });
  });

  test("shared chat dispatch launches multiple explicit pipeline requirements", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please implement the PWA notifications plan in Flight Deck and Tower.",
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "Flight Deck is /srv/code/wingmanbefree/wm-fd-2. Tower is /srv/code/wingmanbefree/wingman-tower.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        createTask: true,
        pipelinesRequired: true,
        pipelines: [
          {
            requirementId: "flight-deck-ui",
            pipeline: "software-implementation-review-loop",
            payload: {
              taskSummary: "Implement Flight Deck PWA notifications UI",
              workdir: "/srv/code/wingmanbefree/wm-fd-2",
              instructions: "Implement the Flight Deck client side of PWA chat notifications.",
              designDocumentUrl: "/srv/code/wingmanbefree/wm-fd-2/tmp/flightdeck-docs/pwa-notifications.md",
              targetSurface: {
                surfaces: ["PWA notification settings", "Chat notification subscription UI"],
                likelyFilesOrAreas: ["src/** notification code", "public/** service worker assets"],
              },
            },
          },
          {
            requirementId: "tower-api",
            pipeline: "software-implementation-review-loop",
            payload: {
              taskSummary: "Implement Tower push notification backend",
              workdir: "/srv/code/wingmanbefree/wingman-tower",
              instructions: "Implement the Tower server side of PWA chat notifications.",
              designDocumentUrl: "/srv/code/wingmanbefree/wingman-tower/tmp/flightdeck-docs/pwa-notifications.md",
              targetSurface: {
                surface: "Flight Deck PG notification APIs",
                existingFiles: ["src/** notification API code"],
              },
            },
          },
        ],
        taskDraft: {
          title: "Implement PWA chat notifications",
          instructions: "Coordinate the Flight Deck and Tower implementations.",
        },
        confidence: 0.94,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    const childPipelines = currentAfterStep(execution, "start-required-pipelines").childPipelines as JsonObject;
    expect(currentAfterStep(execution, "start-selected-pipeline").childPipeline).toBeUndefined();
    expect(childPipelines).toMatchObject({
      started: true,
      total: 2,
      items: [
        {
          requirementId: "flight-deck-ui",
          pipelineDefinitionId: "software-implementation-review-loop",
          workPlan: {
            workdir: "/srv/code/wingmanbefree/wm-fd-2",
            requirementId: "flight-deck-ui",
            taskId: "task-flight-deck-ui",
          },
        },
        {
          requirementId: "tower-api",
          pipelineDefinitionId: "software-implementation-review-loop",
          workPlan: {
            workdir: "/srv/code/wingmanbefree/wingman-tower",
            requirementId: "tower-api",
            taskId: "task-tower-api",
          },
        },
      ],
    });
    expect(result.decision).toMatchObject({
      pipelinesRequired: true,
      dispatchSingleTaskPipeline: false,
      pipelineLaunches: [
        {
          requirementId: "flight-deck-ui",
          pipelineDefinitionId: "software-implementation-review-loop",
        },
        {
          requirementId: "tower-api",
          pipelineDefinitionId: "software-implementation-review-loop",
        },
      ],
    });
    expect(String(result.agentResponse.responseDraft)).toContain("created 2 tasks");
    expect(String(result.agentResponse.responseDraft)).toContain("started 2 pipeline requirements");
  });

  test("shared chat dispatch does not guess repository paths from project names", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please build the feature in the linked doc.",
      agent: {
        workingDirectory: "/srv/code/wingmanbefree/autopilot/data/agent-chat-workspaces/fd-private",
        defaultAgent: "codex",
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "This is the Implementation channel scope for the Wingman Autopilot project. Use the software-implementation-review-loop for implementation.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: true,
        taskDraft: {
          title: "Build linked feature",
          instructions: "Build the linked feature.",
          acceptanceCriteria: ["Feature is implemented."],
        },
        workPlan: {
          taskSummary: "Build linked feature",
          instructions: "Build the linked feature.",
          targetSurface: {
            route: "/docs",
            surface: "Docs",
            existingFiles: ["src/ui/app.js"],
          },
          designDocumentUrl: "/srv/code/wingmanbefree/autopilot/tmp/flightdeck-docs/docs-header.md",
        },
        confidence: 0.91,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(result.decision).toMatchObject({
      dispatchTask: false,
      intent: "clarify",
      pipelineDefinitionId: null,
      workdir: null,
    });
  });

  test("shared chat dispatch rejects software work when only private agent workspace is available", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please build the feature in the linked doc.",
      agent: {
        workingDirectory: "/srv/code/wingmanbefree/autopilot/data/agent-chat-workspaces/fd-private",
        defaultAgent: "codex",
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "Implementation channel, but no repo path is configured.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: true,
        taskDraft: {
          title: "Build linked feature",
          instructions: "Build the linked feature.",
          acceptanceCriteria: ["Feature is implemented."],
        },
        workPlan: {
          taskSummary: "Build linked feature",
          instructions: "Build the linked feature.",
          targetSurface: {
            route: "/docs",
            surface: "Docs",
            existingFiles: ["src/ui/app.js"],
          },
          designDocumentUrl: "/tmp/flightdeck-docs/docs-header.md",
        },
        confidence: 0.91,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(result.decision).toMatchObject({
      dispatchTask: false,
      intent: "clarify",
      missing: ["non-placeholder workdir"],
      workdir: null,
    });
    expect(result.createdTask).toBeUndefined();
    expect(String(result.agentResponse.responseDraft)).toContain("non-placeholder workdir");
  });

  test("shared chat dispatch rejects software work when only archived wingman checkout is available", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please implement the Tiptap design spec.",
      agent: {
        workingDirectory: "/srv/autopilot/data/agent-chat-workspaces/fd-private",
        defaultAgent: "codex",
      },
      channelContext: {
        channelId: "channel-1",
        scopeId: "scope-1",
        name: "Implementation",
        contextPrompt: "Implementation channel, but no repo path is configured.",
        hasSpecificContext: true,
      },
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.95,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "software-implementation-review-loop",
        createTask: true,
        taskDraft: {
          title: "Implement Tiptap docs editor",
          instructions: "Implement the Tiptap docs editor design.",
          acceptanceCriteria: ["The docs editor is implemented."],
        },
        workPlan: {
          taskSummary: "Implement Tiptap docs editor",
          instructions: "Implement the Tiptap docs editor design.",
          targetSurface: {
            route: "/docs",
            surface: "Docs editor",
          },
          designDocumentUrl: "@[Tiptap Design Spec](mention:doc:79b6684f-b5c6-4bb7-8deb-0d6b6c905d05)",
        },
        confidence: 0.91,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(result.decision).toMatchObject({
      dispatchTask: false,
      intent: "clarify",
      missing: ["non-placeholder workdir"],
      workdir: null,
    });
    expect(result.createdTask).toBeUndefined();
  });

  test("shared chat dispatch execution answer_now stays chat-only", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Can you hear me?",
      agentDecision: {
        intent: "answer_now",
        dispatchTask: false,
        chatResponse: { body: "Yes, I can hear you." },
        confidence: 0.96,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(currentAfterStep(execution, "normalise-decision").taskPipelineInput).toBeUndefined();
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "Yes, I can hear you.",
    });
  });

  test("shared chat dispatch execution think_then_answer stays chat-only", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Think through the tradeoffs and answer here.",
      agentDecision: {
        intent: "think_then_answer",
        dispatchTask: false,
        chatResponse: { body: "The main tradeoff is speed versus durability." },
        confidence: 0.86,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "The main tradeoff is speed versus durability.",
    });
  });

  test("shared chat dispatch lets the agent answer operational reviews inline", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please can you review all the Autopilot sessions from today and give me an update on where we're at with our projects?",
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.93,
      },
      agentWorkDecision: {
        action: "reply",
        chatResponse: { body: "I checked today's sessions. Two runs completed, one needs follow-up, and there is no need for a separate task." },
        confidence: 0.91,
      },
    });

    const decision = currentAfterStep(execution, "normalise-agent-work-decision").decision as JsonObject;
    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(decision).toMatchObject({
      dispatchTask: false,
      dispatchPipeline: false,
      intent: "answer_now",
    });
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      responseDraft: "I checked today's sessions. Two runs completed, one needs follow-up, and there is no need for a separate task.",
    });
  });

  test("shared chat dispatch publishes agent clarification without task or child pipeline", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Can you implement the thing?",
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.9,
      },
      agentWorkDecision: {
        action: "clarify",
        clarifyingQuestion: "Which repo and screen should I change?",
        confidence: 0.86,
      },
    });

    const decision = currentAfterStep(execution, "normalise-agent-work-decision").decision as JsonObject;
    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(decision).toMatchObject({
      dispatchTask: false,
      dispatchPipeline: false,
      intent: "clarify",
      clarifyingQuestion: "Which repo and screen should I change?",
    });
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      responseDraft: "Which repo and screen should I change?",
      reasoningSummary: "Asked a clarifying question instead of dispatching work.",
    });
  });

  test("shared chat dispatch execution agent can create a task-backed child pipeline", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Please update the repo and add tests.",
      agentDecision: {
        intent: "agent",
        chatResponse: { body: null },
        confidence: 0.9,
      },
      agentWorkDecision: {
        action: "start_pipeline",
        recommendedPipelineId: "do-and-review",
        createTask: true,
        taskDraft: {
          title: "Update repo and tests",
          instructions: "Update the repo and add tests.",
          acceptanceCriteria: ["Tests cover the change"],
        },
        workPlan: {
          taskSummary: "Update repo and tests",
          instructions: "Update the repo and add tests.",
          workdir: "/repo",
        },
        chatResponse: { body: "Starting the implementation task." },
        confidence: 0.9,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(currentAfterStep(execution, "prepare-task-pipeline-input").taskPipelineInput).toBeUndefined();
    expect(result.createdTask).toMatchObject({ taskId: "task-created" });
    expect(result.childPipeline).toMatchObject({ pipelineDefinitionId: "do-and-review" });
    expect(result.decision).toMatchObject({ dispatchTask: true, taskRoutingPending: false });
  });

  test("dispatch.normaliseChatDispatchDecision uses dispatchTask as the single routing switch", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      chatContext: {
        thread: {
          recent_messages: [
            {
              message_id: "message-1",
              sender_npub: "npub1requester",
              body: "Please research the thing.",
            },
          ],
        },
        referencedRecords: [
          {
            recordId: "doc-1",
            recordFamily: "document",
            payload: { title: "Reference doc", body: "Useful background." },
          },
        ],
      },
      agentDecision: {
        dispatchTask: true,
        recommendedPipelineId: "do-and-review",
        scopeId: "scope-1",
        taskDraft: {
          title: "Research the thing",
          instructions: "Do the research.",
          acceptanceCriteria: ["Report the answer"],
        },
        chatResponse: { body: "Starting the research." },
        confidence: 0.9,
      },
    });

    expect(result.dispatchTask).toBe(true);
    expect(result.pipelineDefinitionId).toBe("do-and-review");
    expect(result.workPlan).toMatchObject({
      workdir: "/repo",
      reviewerNpub: "npub1requester",
      acceptanceCriteria: ["Report the answer"],
      originalPrompt: "Please research the thing.",
      originThread: [
        {
          messageId: "message-1",
          body: "Please research the thing.",
        },
      ],
      referencedRecords: [
        {
          recordId: "doc-1",
          title: "Reference doc",
          summary: "Useful background.",
        },
      ],
    });
    expect("responseOnly" in result).toBe(false);
  });

  test("dispatch.normaliseChatDispatchDecision allows chat task dispatch without a scope", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      agent: { workingDirectory: "/repo" },
      chat: { senderNpub: "npub1requester", channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1", updaterNpub: "npub1requester", payload: {} },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        dispatchTask: true,
        recommendedPipelineId: "do-and-review",
        scopeId: null,
        taskDraft: {
          title: "Handle the image task",
          instructions: "Complete the generic image task.",
          acceptanceCriteria: ["The requested image task is complete"],
        },
        chatResponse: { body: "Starting a generic task." },
        confidence: 0.8,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: true,
      pipelineDefinitionId: "do-and-review",
      scopeId: null,
      missing: [],
      responseDraft: "Starting a generic task.",
    });
    expect(result.workPlan).toMatchObject({
      scopeId: null,
      workdir: "/repo",
      instructions: "Complete the generic image task.",
    });
  });

  test("dispatch.normaliseChatDispatchDecision suppresses self-authored chat dispatches", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      chatContext: {
        shouldProceed: false,
        selfAuthored: true,
        suppressionReason: "trigger_thread_message_sender_is_self",
      },
      chat: { channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1" },
      dispatch: { triggerKind: "chat" },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      shouldRespond: false,
      suppressed: true,
      suppressionReason: "trigger_thread_message_sender_is_self",
    });
  });

  test("shared chat dispatch execution approval-like text does not complete review tasks", async () => {
    const execution = await runChatDispatchSpec({
      latestMessage: "Approved, this is done.",
      referencedRecords: [
        { recordId: "task-review", family: "task", state: "review", title: "Review natural chat dispatch" },
      ],
      agentDecision: {
        intent: "answer_now",
        dispatchTask: false,
        chatResponse: { body: "I see the approval. Task/review workflow will handle any lifecycle transition." },
        confidence: 0.8,
      },
    });

    const result = currentAfterStep(execution, "prepare-chat-response");
    expect(execution.run.status).toBe("ok");
    expect(result.createdTask).toBeUndefined();
    expect(result.childPipeline).toBeUndefined();
    expect(result.reviewApproval).toBeUndefined();
    expect(result.reviewCompletion).toBeUndefined();
    expect(result.agentResponse).toMatchObject({
      shouldRespond: true,
      responseDraft: "I see the approval. Task/review workflow will handle any lifecycle transition.",
    });
  });

  test("dispatch.normaliseChatDispatchDecision honors ignore intent without a fallback reply", async () => {
    const result = await builtinPipelineFunctions["dispatch.normaliseChatDispatchDecision"]!({
      chat: { channelId: "channel-1", threadId: "thread-1" },
      record: { recordId: "message-1" },
      dispatch: { triggerKind: "chat" },
      agentDecision: {
        intent: "ignore",
        dispatchTask: false,
        chatResponse: { body: "" },
        confidence: 1,
      },
    });

    expect(result).toMatchObject({
      dispatchTask: false,
      shouldRespond: false,
      suppressed: true,
      suppressionReason: "agent_intent_ignore",
      responseDraft: "",
    });
  });

  test("dispatch.prepareChatDispatchResponse skips suppressed chat dispatches", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        shouldRespond: false,
        suppressed: true,
        suppressionReason: "trigger_sender_is_self",
      },
    });

    expect(result).toMatchObject({
      shouldRespond: false,
      responseDraft: "",
      actionsTaken: [],
    });
  });

  test("dispatch.prepareChatDispatchResponse links created tasks with Flight Deck mentions", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "research-and-report",
        confidence: 0.9,
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskSummary: "Good Soccer Drills report",
        },
      },
      childPipeline: {
        started: true,
        pipelineName: "research-and-report",
        pipelineRunId: "run-1",
      },
    });

    expect(result.responseDraft).toContain(
      "I created task @[Good Soccer Drills report](mention:task:task-1) and started research-and-report (run-1).",
    );
    expect(result.actionsTaken).toEqual(["created task task-1", "started pipeline run run-1"]);
  });

  test("dispatch.prepareChatDispatchResponse describes reused tasks distinctly", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "software-implementation-review-loop",
        confidence: 0.9,
      },
      createdTask: {
        reused: true,
        taskId: "task-1",
        workPlan: {
          taskSummary: "Existing setup permissions bug",
        },
      },
      childPipeline: {
        started: true,
        pipelineName: "software-implementation-review-loop",
        pipelineRunId: "run-1",
      },
    });

    expect(result.responseDraft).toContain(
      "I reopened task @[Existing setup permissions bug](mention:task:task-1) and started software-implementation-review-loop (run-1).",
    );
    expect(result.reasoningSummary).toBe("Reused an existing task and started the selected pipeline.");
    expect(result.actionsTaken).toEqual(["reused task task-1", "started pipeline run run-1"]);
  });

  test("dispatch.prepareChatDispatchResponse reports immediate child pipeline errors", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "research-and-report",
        confidence: 0.9,
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskSummary: "Session review",
        },
      },
      childPipeline: {
        started: true,
        status: "error",
        pipelineName: "research-and-report",
        pipelineRunId: "run-1",
        reason: "agent callback timed out",
      },
    });

    expect(result.responseDraft).toContain(
      "I created task @[Session review](mention:task:task-1), but the selected pipeline did not start: agent callback timed out.",
    );
    expect(result.reasoningSummary).toBe("Task-backed dispatch created a task, but the selected child pipeline failed to start or errored immediately.");
    expect(result.actionsTaken).toEqual(["created task task-1", "started pipeline run run-1"]);
  });

  test("dispatch.prepareChatDispatchResponse suppresses duplicate reply when needs input was already posted", async () => {
    const result = await builtinPipelineFunctions["dispatch.prepareChatDispatchResponse"]!({
      decision: {
        dispatchTask: true,
        pipelineDefinitionId: "do-and-review",
        confidence: 0.9,
      },
      createdTask: {
        taskId: "task-1",
        workPlan: {
          taskSummary: "Create requested image asset",
        },
      },
      childPipeline: {
        started: true,
        status: "needs_input",
        pipelineName: "do-and-review",
        pipelineRunId: "run-1",
        needsInputUpdate: {
          chatNotified: true,
          question: "What should the image show?",
        },
      },
    });

    expect(result).toMatchObject({
      shouldRespond: false,
      reasoningSummary: "The child pipeline needs input; a clarification question was published.",
    });
    expect(result.responseDraft).toContain("Question: What should the image show?");
  });

  test("memory.searchEntities returns an empty graphContext source set when graph memory is not configured", async () => {
    const previous = {
      PIPELINE_MEMORY_NEO4J_HTTP_URL: process.env.PIPELINE_MEMORY_NEO4J_HTTP_URL,
      NEO4J_HTTP_URL: process.env.NEO4J_HTTP_URL,
      NEO4J_URI: process.env.NEO4J_URI,
      PIPELINE_MEMORY_EMBEDDING_API_KEY: process.env.PIPELINE_MEMORY_EMBEDDING_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.PIPELINE_MEMORY_NEO4J_HTTP_URL;
    delete process.env.NEO4J_HTTP_URL;
    delete process.env.NEO4J_URI;
    delete process.env.PIPELINE_MEMORY_EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let result: Record<string, unknown>;
    try {
      result = await builtinPipelineFunctions["memory.searchEntities"]!({
        entities: [
          { name: "Redshift", type: "system", reason: "secret management", query: "Redshift secret management" },
        ],
      });
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }

    expect(result.matches).toEqual([]);
    expect(result.graphMemoryAvailable).toBe(false);
    expect((result.warnings as string[])[0]).toContain("Neo4j graph memory is not configured");
  });

  test("tower.searchGraph signs NIP-98 requests and normalises Tower graph results", async () => {
    const previousWingmanPriv = process.env.WINGMAN_PRIV;
    const previousFetch = globalThis.fetch;
    const requested: { url?: string; authorization?: string } = {};
    process.env.WINGMAN_PRIV = nip19.nsecEncode(generateSecretKey());
    globalThis.fetch = (async (input, init) => {
      requested.url = String(input);
      requested.authorization = new Headers(init?.headers).get("authorization") || undefined;
      return Response.json({
        query: "Redshift",
        results: [
          {
            kind: "node",
            score: 0.91,
            id: "node-1",
            external_id: "project:redshift",
            source: "tower",
            labels: ["Project"],
            title: "Redshift",
            summary: "Redshift stores encrypted workspace context.",
            properties: { path: "docs/redshift.md" },
          },
        ],
        total: 1,
        limit: 4,
      });
    }) as typeof fetch;

    let result: Record<string, unknown>;
    try {
      result = await builtinPipelineFunctions["tower.searchGraph"]!({
        towerUrl: "http://tower.local",
        ownerNpub: "npub1owner",
        entities: [
          { name: "Redshift", type: "system", reason: "secret management", query: "Redshift" },
        ],
        topKPerEntity: 4,
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWingmanPriv === undefined) delete process.env.WINGMAN_PRIV;
      else process.env.WINGMAN_PRIV = previousWingmanPriv;
    }

    expect(requested.url).toContain("http://tower.local/api/v4/graph/search");
    expect(requested.url).toContain("workspace_owner_npub=npub1owner");
    expect(requested.authorization).toStartWith("Nostr ");
    expect(result.graphMemoryAvailable).toBe(true);
    expect(result.source).toBe("tower-postgres-graph");
    expect(result.matches).toEqual([
      {
        id: "node-1",
        entity: "Redshift",
        entityType: "system",
        title: "Redshift",
        source: "tower",
        score: 0.91,
        excerpt: "Redshift stores encrypted workspace context.",
        labels: ["node", "Project"],
      },
    ]);
  });

  test("memory.consolidateGraphContext returns graphContext and source metadata", async () => {
    const result = await builtinPipelineFunctions["memory.consolidateGraphContext"]!({
      entities: [{ name: "Redshift", type: "system", query: "Redshift", reason: "secret manager" }],
      matches: [
        {
          id: "node-1",
          entity: "Redshift",
          entityType: "system",
          title: "Redshift Secret Plan",
          source: "docs/redshift-secrets-plan.md",
          score: 0.91,
          excerpt: "Redshift stores encrypted secrets as Nostr events.",
          labels: ["DocumentChunk"],
        },
      ],
      maxChars: 2000,
    });

    expect(result.graphContext).toContain("potential context from long-term memory");
    expect(result.graphContext).toContain("Redshift Secret Plan");
    expect(result.graphContextAvailable).toBe(true);
    expect(result.graphContextSources).toEqual([
      {
        id: "node-1",
        entity: "Redshift",
        entityType: "system",
        title: "Redshift Secret Plan",
        source: "docs/redshift-secrets-plan.md",
        score: 0.91,
        excerpt: "Redshift stores encrypted secrets as Nostr events.",
        labels: ["DocumentChunk"],
      },
    ]);
  });
});
