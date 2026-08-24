import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import type { SessionApiContext } from "../server/session-api-routes";
import { builtinPipelineFunctions } from "./functions";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import {
  acceptAgentCallback,
  resumeDeclarativePipeline,
  resumeErroredDeclarativePipeline,
  runDeclarativePipeline,
} from "./pipeline-runner";
import { runParallelStep } from "./parallel-runner";
import { PipelineStore } from "./pipeline-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingmen-pipeline-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.PIPELINE_PARALLEL_POLL_MS;
  delete process.env.PIPELINE_PARALLEL_AGENT_START_RETRY_BACKOFF_MS;
  delete process.env.PIPELINE_AGENT_INPUT_MAX_BYTES;
  delete process.env.PIPELINE_AGENT_CALLBACK_TIMEOUT_RETRIES;
  delete process.env.PIPELINE_AGENT_STEP_MAX_ATTEMPTS;
  delete process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY;
  globalThis.fetch = nativeFetch;
});

const makeStore = () => new PipelineStore(join(tempDir, "pipelines.sqlite"));
const nativeFetch = globalThis.fetch;

describe("runDeclarativePipeline", () => {
  test("runs object-in object-out code steps and records each step", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "test",
      slug: "test",
      name: "test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "test.json"),
      spec: {
        name: "test",
        input: { text: "  Build declarative JSON pipelines  " },
        steps: [
          {
            name: "normalise",
            type: "code",
            function: "text.normalise",
            input: { pick: { text: "$.text" } },
            assign: "$.normalised",
          },
          {
            name: "features",
            type: "code",
            function: "text.features",
            input: { pick: { text: "$.normalised.text", words: "$.normalised.words" } },
            assign: "$.features",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.features).toMatchObject({ mentionsJson: true, mentionsPipeline: true });
    expect(store.listSteps(run.id).map((step) => step.status)).toEqual(["ok", "ok"]);
    expect(store.listSteps(run.id)[0]?.metadata).toMatchObject({
      type: "code",
      input: { pick: { text: "$.text" } },
      assign: "$.normalised",
      executor: { kind: "function", function: "text.normalise" },
    });
  });

  test("resumes an errored historical run from the failed top-level step", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "manual-resume-test",
      slug: "manual-resume-test",
      name: "manual-resume-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "manual-resume-test.json"),
      spec: {
        name: "manual-resume-test",
        input: { value: 1 },
        steps: [
          {
            name: "first",
            type: "code",
            function: "test.first",
            assign: "$.first",
          },
          {
            name: "flaky",
            type: "code",
            function: "test.flaky",
            assign: "$.flaky",
          },
          {
            name: "final",
            type: "code",
            function: "test.final",
            assign: "$.final",
          },
        ],
      },
    };
    let shouldFail = true;

    const failedRun = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        async "test.first"() {
          return { value: "done" };
        },
        async "test.flaky"() {
          if (shouldFail) throw new Error("temporary failure");
          return { value: "recovered" };
        },
        async "test.final"() {
          return { value: "complete" };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(failedRun.status).toBe("error");
    expect(failedRun.cursorIndex).toBe(1);
    expect(store.listSteps(failedRun.id).map((step) => [step.name, step.status])).toEqual([
      ["first", "ok"],
      ["flaky", "error"],
    ]);

    shouldFail = false;
    const resumedRun = await resumeErroredDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        async "test.first"() {
          throw new Error("first step should not run again");
        },
        async "test.flaky"() {
          return { value: "recovered" };
        },
        async "test.final"() {
          return { value: "complete" };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    }, failedRun.id);

    expect(resumedRun?.status).toBe("ok");
    expect(resumedRun?.result?.first).toEqual({ value: "done" });
    expect(resumedRun?.result?.flaky).toEqual({ value: "recovered" });
    expect(resumedRun?.result?.final).toEqual({ value: "complete" });
    expect(store.listSteps(failedRun.id).map((step) => [step.name, step.status])).toEqual([
      ["first", "ok"],
      ["flaky", "error"],
      ["flaky", "ok"],
      ["final", "ok"],
    ]);
  });

  test("can split paragraphs, parse a paragraph analysis, and finalise the result", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "paragraph-test",
      slug: "paragraph-test",
      name: "paragraph-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "paragraph-test.json"),
      spec: {
        name: "paragraph-test",
        input: {
          targetParagraphNumber: 2,
          text: [
            "First paragraph introduces the subject.",
            "Second paragraph contains the decision point that needs agent analysis.",
            "Third paragraph gives the surrounding context.",
          ].join("\n\n"),
        },
        steps: [
          {
            name: "split",
            type: "code",
            function: "text.paragraphs",
            input: { pick: { text: "$.text", targetParagraphNumber: "$.targetParagraphNumber" } },
            assign: "$.document",
          },
          {
            name: "fake-agent-output",
            type: "code",
            function: "test.fakeParagraphAnalysis",
            assign: "$.agentRaw",
          },
          {
            name: "parse",
            type: "code",
            function: "agent.parseParagraphAnalysis",
            input: { pick: { raw: "$.agentRaw", paragraph: "$.document.selectedParagraph" } },
            assign: "$.analysis",
          },
          {
            name: "finalise",
            type: "code",
            function: "object.finaliseParagraphAnalysis",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        ...builtinPipelineFunctions,
        async "test.fakeParagraphAnalysis"() {
          return {
            summary: "The paragraph asks for a decision point to be analysed.",
            sentiment: "neutral",
            keyPoints: ["decision point", "agent analysis"],
            actionRequired: true,
            confidence: 0.9,
          };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.selectedParagraph).toMatchObject({ number: 2 });
    expect(run.result?.analysis).toMatchObject({
      paragraphNumber: 2,
      actionRequired: true,
      keyPoints: ["decision point", "agent analysis"],
    });
  });

  test("runs classifier steps through OpenRouter JSON completion without launching an agent", async () => {
    const store = makeStore();
    const calls: Array<{ body: unknown; authorization: string | null }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        body: JSON.parse(String(init?.body ?? "{}")),
        authorization: headers.get("authorization"),
      });
      return new Response(JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ intent: "answer_now", dispatchTask: false }) } },
        ],
      }), { status: 200 });
    }) as typeof fetch;

    const definition: PipelineDefinitionRecord = {
      id: "classifier-test",
      slug: "classifier-test",
      name: "classifier-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "classifier-test.json"),
      spec: {
        name: "classifier-test",
        input: { text: "hello" },
        steps: [
          {
            name: "classify",
            type: "classifier",
            provider: "openrouter",
            model: "openai/gpt-oss-120b:nitro",
            prompt: "Classify the input.",
            input: { pick: { text: "$.text" } },
            assign: "$.decision",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {
        userSettingsStore: {
          getAll: () => ({ speech_api_key: "stored-speech-openrouter-key" }),
        },
      } as never,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.decision).toEqual({ intent: "answer_now", dispatchTask: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer stored-speech-openrouter-key");
    const step = store.listSteps(run.id)[0]!;
    expect(step.kind).toBe("classifier");
    expect(step.wingmanSessionId).toBeNull();
    expect(step.metadata).toMatchObject({
      executor: {
        kind: "classifier",
        provider: "openrouter",
        model: "openai/gpt-oss-120b:nitro",
      },
    });
  });

  test("retries classifier steps up to the configured limit before accepting valid JSON", async () => {
    const store = makeStore();
    process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const content = calls < 3
        ? "not json"
        : JSON.stringify({ recommendedPipelineId: "do-and-review", confidence: 0.9 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;

    const definition: PipelineDefinitionRecord = {
      id: "classifier-retry-test",
      slug: "classifier-retry-test",
      name: "classifier-retry-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "classifier-retry-test.json"),
      spec: {
        name: "classifier-retry-test",
        input: { text: "build it" },
        steps: [
          {
            name: "classify",
            type: "classifier",
            provider: "openrouter",
            model: "openai/gpt-oss-120b:nitro",
            prompt: "Choose a pipeline.",
            retries: 3,
            input: { pick: { text: "$.text" } },
            assign: "$.selection",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect(calls).toBe(3);
    expect(run.result?.selection).toEqual({ recommendedPipelineId: "do-and-review", confidence: 0.9 });
  });

  test("runs a flat loop-control step for a bounded number of iterations", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "loop-test",
      slug: "loop-test",
      name: "loop-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "loop-test.json"),
      spec: {
        name: "loop-test",
        input: {
          count: 3,
          reviewLoop: { iteration: 1, index: 0, completed: 0, total: 3, done: false },
        },
        steps: [
          {
            id: "fake-critic",
            name: "fake-critic",
            type: "code",
            function: "test.fakeCritic",
            input: { pick: { loop: "$.reviewLoop" } },
            assign: "$.iteration.critic",
          },
          {
            id: "fake-response",
            name: "fake-response",
            type: "code",
            function: "test.fakeResponse",
            input: { pick: { loop: "$.reviewLoop", critic: "$.iteration.critic" } },
            assign: "$.iteration.response",
          },
          {
            id: "loop-to-critic",
            name: "loop-to-critic",
            type: "loop",
            target: "fake-critic",
            iterations: "$.count",
            counter: "$.reviewLoop",
            history: "$.reviewHistory",
            capture: {
              critic: "$.iteration.critic",
              response: "$.iteration.response",
            },
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        ...builtinPipelineFunctions,
        async "test.fakeCritic"(input) {
          const loop = input.loop as { iteration?: number };
          return { summary: `critic iteration ${loop.iteration}` };
        },
        async "test.fakeResponse"(input) {
          const loop = input.loop as { iteration?: number };
          return { summary: `response iteration ${loop.iteration}` };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect((run.result?.reviewHistory as { items?: unknown[] })?.items).toHaveLength(3);
    expect(store.listSteps(run.id).map((step) => step.kind)).toEqual([
      "code",
      "code",
      "loop",
      "code",
      "code",
      "loop",
      "code",
      "code",
      "loop",
    ]);
    expect(run.result?.reviewLoop).toMatchObject({ completed: 3, done: true });
  });

  test("fails clearly before launching an agent when selected input is too large", async () => {
    process.env.PIPELINE_AGENT_INPUT_MAX_BYTES = "120";
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "agent-size-guard",
      slug: "agent-size-guard",
      name: "agent-size-guard",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "agent-size-guard.json"),
      spec: {
        name: "agent-size-guard",
        input: {
          records: Array.from({ length: 20 }, (_, index) => ({
            name: `Company ${index}`,
            summary: "This record should be compacted before reaching an agent step.",
          })),
        },
        steps: [
          {
            name: "oversized-agent",
            type: "agent",
            prompt: "Summarise the selected records.",
            input: { pick: { records: "$.records" } },
            assign: "$.agentResult",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("error");
    expect(run.error).toContain("Agent step input is");
    expect(run.error).toContain("Compact step input or pass artifact references");
    const [step] = store.listSteps(run.id);
    expect(step?.status).toBe("error");
    expect(step?.wingmanSessionId).toBeNull();
  });

  test("delivers agent steps through the session adapter when the active transport is native", async () => {
    const store = makeStore();
    const sessionId = "native-codex-session";
    const session = {
      id: sessionId,
      agent: "codex",
      port: 49999,
      name: "Pipeline native agent",
      status: "running",
      startedAt: new Date().toISOString(),
      workingDirectory: tempDir,
      command: [],
      logs: [],
      metadata: {},
    } as SessionSnapshot;
    let adapterSendCount = 0;
    const adapter: AgentAdapter = {
      async fetchStatus() {
        return "stable";
      },
      async getPromptReadiness() {
        return { state: "ready", reason: "test-native-ready", retryAfterMs: 1, observedAt: Date.now() };
      },
      async sendMessage(content) {
        adapterSendCount += 1;
        const urlMatch = content.match(/http:\/\/callback\.local\/api\/pipelines\/runs\/[^\s']+/);
        expect(urlMatch).not.toBeNull();
        const callbackUrl = new URL(urlMatch![0]);
        const segments = callbackUrl.pathname.split("/");
        const runId = decodeURIComponent(segments[4] ?? "");
        const stepId = decodeURIComponent(segments[6] ?? "");
        const token = callbackUrl.searchParams.get("token") ?? "";
        await acceptAgentCallback({
          store,
          runId,
          stepId,
          token,
          payload: {
            runId,
            stepId,
            status: "ok",
            result: { answer: "native adapter delivered" },
          },
        });
      },
      deliversPromptsDirectly() {
        return true;
      },
      async fetchMessages() {
        return [];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };
    const sessionApiContext = {
      manager: {
        async createSession() {
          return session;
        },
        getSession(id: string) {
          return id === sessionId ? session : null;
        },
        getAdapter(id: string) {
          return id === sessionId ? adapter : null;
        },
        async stopSession() {
          return true;
        },
      },
      agentHost: "localhost",
      buildAgentUrl(host: string, port: number, path: string) {
        return new URL(`http://${host}:${port}${path}`);
      },
      messageStore: {
        recordSession() {},
      },
      async syncSessionMessages() {},
      scheduleSessionArchive() {},
      isAgentType(value: string) {
        return value === "codex";
      },
    } as unknown as SessionApiContext;
    const definition: PipelineDefinitionRecord = {
      id: "native-agent-test",
      slug: "native-agent-test",
      name: "native-agent-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "native-agent-test.json"),
      spec: {
        name: "native-agent-test",
        input: { topic: "transport" },
        steps: [
          {
            name: "agent",
            type: "agent",
            prompt: "Return a transport result.",
            assign: "$.agentRaw",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://callback.local",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.agentRaw).toEqual({ answer: "native adapter delivered" });
    expect(adapterSendCount).toBe(1);
    expect(store.listSteps(run.id)[0]?.wingmanSessionId).toBe(sessionId);
  });

  test("retries an agent step from the same persisted point after callback timeout", async () => {
    process.env.PIPELINE_AGENT_CALLBACK_TIMEOUT_RETRIES = "1";
    const store = makeStore();
    let createCount = 0;
    let adapterSendCount = 0;
    const sessions = new Map<string, SessionSnapshot>();
    const adapter: AgentAdapter = {
      async fetchStatus() {
        return "stable";
      },
      async getPromptReadiness() {
        return { state: "ready", reason: "test-native-ready", retryAfterMs: 1, observedAt: Date.now() };
      },
      async sendMessage(content) {
        adapterSendCount += 1;
        if (adapterSendCount === 1) return;
        const urlMatch = content.match(/http:\/\/callback\.local\/api\/pipelines\/runs\/[^\s']+/);
        expect(urlMatch).not.toBeNull();
        const callbackUrl = new URL(urlMatch![0]);
        const segments = callbackUrl.pathname.split("/");
        const runId = decodeURIComponent(segments[4] ?? "");
        const stepId = decodeURIComponent(segments[6] ?? "");
        const token = callbackUrl.searchParams.get("token") ?? "";
        await acceptAgentCallback({
          store,
          runId,
          stepId,
          token,
          payload: {
            runId,
            stepId,
            status: "ok",
            result: { answer: "retry delivered" },
          },
        });
      },
      deliversPromptsDirectly() {
        return true;
      },
      async fetchMessages() {
        return [];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };
    const sessionApiContext = {
      manager: {
        async createSession() {
          createCount += 1;
          const session = {
            id: `retry-codex-session-${createCount}`,
            agent: "codex",
            port: 49999 + createCount,
            name: "Pipeline retry agent",
            status: "running",
            startedAt: new Date().toISOString(),
            workingDirectory: tempDir,
            command: [],
            logs: [],
            metadata: {},
          } as SessionSnapshot;
          sessions.set(session.id, session);
          return session;
        },
        getSession(id: string) {
          return sessions.get(id) ?? null;
        },
        getAdapter(id: string) {
          return sessions.has(id) ? adapter : null;
        },
        async stopSession() {
          return true;
        },
      },
      agentHost: "localhost",
      buildAgentUrl(host: string, port: number, path: string) {
        return new URL(`http://${host}:${port}${path}`);
      },
      messageStore: {
        recordSession() {},
      },
      async syncSessionMessages() {},
      scheduleSessionArchive() {},
      isAgentType(value: string) {
        return value === "codex";
      },
    } as unknown as SessionApiContext;
    const definition: PipelineDefinitionRecord = {
      id: "agent-timeout-retry",
      slug: "agent-timeout-retry",
      name: "agent-timeout-retry",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "agent-timeout-retry.json"),
      spec: {
        name: "agent-timeout-retry",
        input: { topic: "timeout" },
        steps: [
          {
            name: "agent",
            type: "agent",
            prompt: "Return a timeout result.",
            timeoutMs: 1000,
            assign: "$.agentRaw",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://callback.local",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.agentRaw).toEqual({ answer: "retry delivered" });
    expect(createCount).toBe(2);
    expect(adapterSendCount).toBe(2);
    const [step] = store.listSteps(run.id);
    expect(step?.status).toBe("ok");
    expect(step?.wingmanSessionId).toBe("retry-codex-session-2");
  });

  test("retries an agent step with a fresh session after transient delivery failures", async () => {
    const store = makeStore();
    let createCount = 0;
    let adapterSendCount = 0;
    const sessions = new Map<string, SessionSnapshot>();
    const adapter: AgentAdapter = {
      async fetchStatus() {
        return "stable";
      },
      async getPromptReadiness() {
        return { state: "ready", reason: "test-native-ready", retryAfterMs: 1, observedAt: Date.now() };
      },
      async sendMessage(content) {
        adapterSendCount += 1;
        if (adapterSendCount < 3) {
          throw new Error("Internal Server Error");
        }
        const urlMatch = content.match(/http:\/\/callback\.local\/api\/pipelines\/runs\/[^\s']+/);
        expect(urlMatch).not.toBeNull();
        const callbackUrl = new URL(urlMatch![0]);
        const segments = callbackUrl.pathname.split("/");
        const runId = decodeURIComponent(segments[4] ?? "");
        const stepId = decodeURIComponent(segments[6] ?? "");
        const token = callbackUrl.searchParams.get("token") ?? "";
        await acceptAgentCallback({
          store,
          runId,
          stepId,
          token,
          payload: {
            runId,
            stepId,
            status: "ok",
            result: { answer: "delivery retry delivered" },
          },
        });
      },
      deliversPromptsDirectly() {
        return true;
      },
      async fetchMessages() {
        return [];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };
    const sessionApiContext = {
      manager: {
        async createSession() {
          createCount += 1;
          const session = {
            id: `delivery-retry-codex-session-${createCount}`,
            agent: "codex",
            port: 50100 + createCount,
            name: "Pipeline delivery retry agent",
            status: "running",
            startedAt: new Date().toISOString(),
            workingDirectory: tempDir,
            command: [],
            logs: [],
            metadata: {},
          } as SessionSnapshot;
          sessions.set(session.id, session);
          return session;
        },
        getSession(id: string) {
          return sessions.get(id) ?? null;
        },
        getAdapter(id: string) {
          return sessions.has(id) ? adapter : null;
        },
        async stopSession(id: string) {
          sessions.delete(id);
          return true;
        },
      },
      agentHost: "localhost",
      buildAgentUrl(host: string, port: number, path: string) {
        return new URL(`http://${host}:${port}${path}`);
      },
      messageStore: {
        recordSession() {},
      },
      async syncSessionMessages() {},
      scheduleSessionArchive() {},
      isAgentType(value: string) {
        return value === "codex";
      },
    } as unknown as SessionApiContext;
    const definition: PipelineDefinitionRecord = {
      id: "agent-delivery-retry",
      slug: "agent-delivery-retry",
      name: "agent-delivery-retry",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "agent-delivery-retry.json"),
      spec: {
        name: "agent-delivery-retry",
        input: { topic: "delivery" },
        steps: [
          {
            name: "agent",
            type: "agent",
            prompt: "Return a delivery retry result.",
            assign: "$.agentRaw",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext,
      definition,
      registry: builtinPipelineFunctions,
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://callback.local",
    });

    expect(run.status).toBe("ok");
    expect(run.result?.agentRaw).toEqual({ answer: "delivery retry delivered" });
    expect(createCount).toBe(3);
    expect(adapterSendCount).toBe(3);
    const [step] = store.listSteps(run.id);
    expect(step?.status).toBe("ok");
    expect(step?.wingmanSessionId).toBe("delivery-retry-codex-session-3");
  });

  test("runs parallel child steps and aggregates results", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "parallel-test",
      slug: "parallel-test",
      name: "parallel-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "parallel-test.json"),
      spec: {
        name: "parallel-test",
        input: { values: ["alpha", "beta", "gamma"] },
        steps: [
          {
            name: "fan-out",
            type: "parallel",
            source: "$.values",
            maxConcurrency: 2,
            itemInput: { pick: { value: "$item", index: "$index" } },
            step: {
              name: "uppercase",
              type: "code",
              function: "test.uppercase",
            },
            assign: "$.parallel",
          },
        ],
      },
    };

    const run = await runDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        ...builtinPipelineFunctions,
        async "test.uppercase"(input) {
          return { value: String(input.value).toUpperCase(), index: input.index };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    });

    expect(run.status).toBe("ok");
    expect((run.result?.parallel as { ok?: number })?.ok).toBe(3);
    expect((run.result?.parallel as { items?: Array<{ result: { value: string } }> })?.items?.map((item) => item.result.value)).toEqual([
      "ALPHA",
      "BETA",
      "GAMMA",
    ]);
    expect(store.listSteps(run.id).map((step) => step.kind)).toEqual(["parallel", "code", "code", "code"]);
  });

  test("stagger-starts parallel agent children while allowing active concurrency", async () => {
    process.env.PIPELINE_PARALLEL_POLL_MS = "5";
    const store = makeStore();
    const run = store.createRun({
      definitionId: "parallel-agent",
      name: "parallel-agent",
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      scope: "user",
      input: { values: ["alpha", "beta", "gamma", "delta"] },
    });
    let stepIndex = 0;
    const parent = store.createStep({
      runId: run.id,
      stepIndex: stepIndex++,
      name: "fan-out",
      kind: "parallel",
      input: run.input ?? {},
    });
    let launching = 0;
    let activeAgents = 0;
    let maxLaunching = 0;
    let maxActiveAgents = 0;

    const aggregate = await runParallelStep({
      store,
      registry: builtinPipelineFunctions,
      runId: run.id,
      current: run.input ?? {},
      nextStepIndex: () => stepIndex++,
      parentStep: {
        name: "fan-out",
        type: "parallel",
        source: "$.values",
        maxConcurrency: 4,
        agentLaunchConcurrency: 1,
        itemInput: { pick: { value: "$item" } },
        step: {
          name: "review",
          type: "agent",
          prompt: "Review the value.",
        },
      },
      parentStepId: parent.id,
      parentStepName: "fan-out",
      shouldRelaunchAgentChild: () => false,
      runAgentChild: async ({ childRecord, selectedInput }) => {
        launching += 1;
        activeAgents += 1;
        maxLaunching = Math.max(maxLaunching, launching);
        maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
        await new Promise((resolve) => setTimeout(resolve, 20));
        store.setStepSession(childRecord.id, `session-${selectedInput.value}`);
        launching -= 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        store.completeStep({
          id: childRecord.id,
          status: "ok",
          result: { value: selectedInput.value },
          output: { value: selectedInput.value },
          wingmanSessionId: `session-${selectedInput.value}`,
        });
        activeAgents -= 1;
      },
    });

    expect(aggregate).toMatchObject({ total: 4, ok: 4, error: 0 });
    expect(maxLaunching).toBe(1);
    expect(maxActiveAgents).toBeGreaterThan(1);
  });

  test("retries parallel agent PM2 startup failures before marking the child failed", async () => {
    process.env.PIPELINE_PARALLEL_POLL_MS = "5";
    process.env.PIPELINE_PARALLEL_AGENT_START_RETRY_BACKOFF_MS = "1";
    const store = makeStore();
    const run = store.createRun({
      definitionId: "parallel-agent-retry",
      name: "parallel-agent-retry",
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      scope: "user",
      input: { values: ["alpha"] },
    });
    let stepIndex = 0;
    const parent = store.createStep({
      runId: run.id,
      stepIndex: stepIndex++,
      name: "fan-out",
      kind: "parallel",
      input: run.input ?? {},
    });
    let attempts = 0;

    const aggregate = await runParallelStep({
      store,
      registry: builtinPipelineFunctions,
      runId: run.id,
      current: run.input ?? {},
      nextStepIndex: () => stepIndex++,
      parentStep: {
        name: "fan-out",
        type: "parallel",
        source: "$.values",
        maxConcurrency: 1,
        agentStartupRetries: 1,
        step: {
          name: "review",
          type: "agent",
          prompt: "Review the value.",
        },
      },
      parentStepId: parent.id,
      parentStepName: "fan-out",
      shouldRelaunchAgentChild: () => false,
      runAgentChild: async ({ childRecord }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("PM2 process pipeline-review failed to start within timeout");
        }
        store.setStepSession(childRecord.id, "session-alpha");
        store.completeStep({
          id: childRecord.id,
          status: "ok",
          result: { value: "alpha" },
          output: { value: "alpha" },
          wingmanSessionId: "session-alpha",
        });
      },
    });

    expect(attempts).toBe(2);
    expect(aggregate).toMatchObject({ total: 1, ok: 1, error: 0 });
  });

  test("resumes a run after an agent callback completed during downtime", async () => {
    const store = makeStore();
    const definition: PipelineDefinitionRecord = {
      id: "resume-test",
      slug: "resume-test",
      name: "resume-test",
      scope: "user",
      ownerAlias: "alpha-beta-gamma",
      path: join(tempDir, "resume-test.json"),
      spec: {
        name: "resume-test",
        input: { seed: true },
        steps: [
          {
            name: "prepare",
            type: "code",
            function: "test.prepare",
            assign: "$.prepared",
          },
          {
            name: "agent",
            type: "agent",
            prompt: "Return a decision.",
            assign: "$.agentRaw",
          },
          {
            name: "finalise",
            type: "code",
            function: "test.finalise",
          },
        ],
      },
    };
    const run = store.createRun({
      definitionId: definition.id,
      definitionPath: definition.path,
      name: definition.name,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      scope: "user",
      input: definition.spec.input!,
    });
    const prepared = { seed: true, prepared: { ok: true } };
    store.updateRunProgress(run.id, prepared, 1);
    const agentStep = store.createStep({
      runId: run.id,
      stepIndex: 1,
      name: "agent",
      kind: "agent",
      input: prepared,
      callbackToken: "secret-token",
    });
    store.setRunActiveStep(run.id, agentStep.id);

    await acceptAgentCallback({
      store,
      runId: run.id,
      stepId: agentStep.id,
      token: "secret-token",
      payload: { runId: run.id, stepId: agentStep.id, status: "ok", result: { decision: "continue" } },
    });

    const resumed = await resumeDeclarativePipeline({
      store,
      sessionApiContext: {} as never,
      definition,
      registry: {
        ...builtinPipelineFunctions,
        async "test.prepare"() {
          return { ok: true };
        },
        async "test.finalise"(input) {
          return { done: true, decision: (input.agentRaw as { decision?: string }).decision };
        },
      },
      input: definition.spec.input!,
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      callbackOrigin: "http://localhost",
    }, run.id);

    expect(resumed?.status).toBe("ok");
    expect(resumed?.result).toEqual({ done: true, decision: "continue" });
    expect(store.listSteps(run.id).map((step) => step.name)).toEqual(["agent", "finalise"]);
  });
});

describe("acceptAgentCallback", () => {
  test("requires the callback token and stores accepted callbacks", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition",
      name: "definition",
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      scope: "user",
      input: {},
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "agent",
      kind: "agent",
      input: {},
      callbackToken: "secret-token",
    });

    const rejected = await acceptAgentCallback({
      store,
      runId: run.id,
      stepId: step.id,
      token: "wrong-token",
      payload: { runId: run.id, stepId: step.id, status: "ok", result: {} },
    });

    expect(rejected.status).toBe(401);
    expect(store.getStep(step.id)?.status).toBe("running");

    const accepted = await acceptAgentCallback({
      store,
      runId: run.id,
      stepId: step.id,
      token: "secret-token",
      payload: { runId: run.id, stepId: step.id, status: "ok", result: { answer: "done" } },
    });

    expect(accepted.status).toBe(200);
    expect(store.getStep(step.id)?.result).toEqual({ answer: "done" });
    expect(store.listCallbacksForStep(step.id).map((callback) => callback.accepted)).toEqual([0, 1]);
  });

  test("rejects late callbacks after a step is cancelled", async () => {
    const store = makeStore();
    const run = store.createRun({
      definitionId: "definition",
      name: "definition",
      ownerNpub: "npub-test",
      ownerAlias: "alpha-beta-gamma",
      scope: "user",
      input: {},
    });
    const step = store.createStep({
      runId: run.id,
      stepIndex: 0,
      name: "agent",
      kind: "agent",
      input: {},
      callbackToken: "secret-token",
    });
    store.cancelRun(run.id, "Stopped by test");

    const rejected = await acceptAgentCallback({
      store,
      runId: run.id,
      stepId: step.id,
      token: "secret-token",
      payload: { runId: run.id, stepId: step.id, status: "ok", result: { answer: "late" } },
    });

    expect(rejected.status).toBe(409);
    expect(store.getStep(step.id)?.status).toBe("cancelled");
    expect(store.getStep(step.id)?.result).toBeNull();
    expect(store.listCallbacksForStep(step.id).map((callback) => callback.accepted)).toEqual([0]);
  });
});
