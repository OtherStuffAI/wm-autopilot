import type { AgentType } from "../config";
import type { SessionSnapshot } from "../agents/process-manager";
import { deliverSessionAgentMessage } from "../server/session-agent-message";
import type { SessionApiContext } from "../server/session-api-routes";
import { waitForSessionPromptReadiness } from "../server/session-readiness";
import {
  assignOutput,
  assertObject,
  selectInput,
  shouldRunStep,
  resolvePath,
  type DeclarativeStep,
  type FunctionRegistry,
} from "./declarative";
import { runParallelStep } from "./parallel-runner";
import { expandPipelineBlock } from "./pipeline-blocks";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { buildPipelineStepMetadata } from "./pipeline-step-metadata";
import { type JsonObject, PipelineStore, type PipelineStatus, type PipelineStepRecord, type StepKind } from "./pipeline-store";

const CALLBACK_POLL_MS = 1000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PIPELINE_EXECUTED_STEPS = 2000;
const DEFAULT_AGENT_INPUT_MAX_BYTES = 250_000;
const DEFAULT_AGENT_STEP_MAX_ATTEMPTS = 3;
const DEFAULT_CLASSIFIER_MODEL = "openai/gpt-oss-120b:nitro";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 8_000;
const DEFAULT_CLASSIFIER_ATTEMPTS = 3;
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const activeRunExecutions = new Set<string>();

interface PipelineRunnerInput {
  store: PipelineStore;
  sessionApiContext: SessionApiContext;
  definition: PipelineDefinitionRecord;
  registry: FunctionRegistry;
  input: JsonObject;
  ownerNpub: string | null;
  ownerAlias: string | null;
  callbackOrigin: string;
  defaultAgent?: string;
  onRunCreated?: (run: ReturnType<PipelineStore["createRun"]>) => void;
}

export class PipelineHalt extends Error {
  constructor(
    readonly status: PipelineStatus,
    readonly result: JsonObject,
    message: string,
  ) {
    super(message);
  }
}

class PipelineCallbackTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for pipeline agent callback after ${Math.round(timeoutMs / 1000)}s`);
  }
}

class PipelineCancelled extends Error {
  constructor(readonly runId: string) {
    super("Pipeline run cancelled");
  }
}

export async function runDeclarativePipeline(input: PipelineRunnerInput) {
  const run = createPipelineRun(input);
  return await executeDeclarativePipeline(input, run.id);
}

export function startDeclarativePipeline(input: PipelineRunnerInput) {
  const run = createPipelineRun(input);
  void executeDeclarativePipeline(input, run.id);
  return run;
}

export async function resumeDeclarativePipeline(input: PipelineRunnerInput, runId: string) {
  const run = input.store.getRun(runId);
  if (!run || run.status !== "running") return run;
  return await executeDeclarativePipeline(input, runId);
}

export async function resumeErroredDeclarativePipeline(input: PipelineRunnerInput, runId: string) {
  const run = input.store.reopenErroredRun(runId);
  if (!run || run.status !== "running") return run;
  return await executeDeclarativePipeline(input, runId);
}

function createPipelineRun(input: PipelineRunnerInput) {
  const { store, definition } = input;
  const run = store.createRun({
    definitionId: definition.id,
    definitionPath: definition.path,
    name: definition.spec.name,
    ownerNpub: input.ownerNpub,
    ownerAlias: input.ownerAlias,
    scope: definition.scope,
    input: input.input,
  });
  input.onRunCreated?.(run);
  return run;
}

async function executeDeclarativePipeline(input: PipelineRunnerInput, runId: string) {
  if (activeRunExecutions.has(runId)) {
    return input.store.getRun(runId)!;
  }
  activeRunExecutions.add(runId);
  const { store, definition } = input;
  const persisted = store.getRun(runId);
  let current = persisted?.current ?? input.input;
  let cursor = persisted?.cursorIndex ?? 0;
  let stepIndex = nextStoredStepIndex(store, runId);
  let executedSteps = 0;
  const topLevelSteps = definition.spec.steps;
  const stepTargetIndex = buildStepTargetIndex(topLevelSteps);

  try {
    while (cursor < topLevelSteps.length) {
      throwIfRunCancelled(store, runId);
      executedSteps += 1;
      if (executedSteps > MAX_PIPELINE_EXECUTED_STEPS) {
        throw new Error("Pipeline exceeded the maximum step execution limit");
      }
      const step = topLevelSteps[cursor]!;
      const outcome = await executePipelineStep({
        ...input,
        runId,
        step,
        current,
        nextStepIndex: () => stepIndex++,
        targetIndex: stepTargetIndex,
      });
      throwIfRunCancelled(store, runId);
      current = outcome.current;
      cursor = typeof outcome.jumpTo === "number" ? outcome.jumpTo : cursor + 1;
      store.updateRunProgress(runId, current, cursor);
    }

    return store.completeRun(runId, "ok", current);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PipelineHalt) {
      return store.completeRun(runId, error.status, error.result, error.message);
    }
    if (error instanceof PipelineCancelled) {
      return store.getRun(runId)!;
    }
    completeActiveStepOnError(store, runId, current, message);
    store.setRunActiveStep(runId, null);
    return store.completeRun(runId, "error", current, message);
  } finally {
    activeRunExecutions.delete(runId);
  }
}

function throwIfRunCancelled(store: PipelineStore, runId: string): void {
  const run = store.getRun(runId);
  if (run?.status === "cancelled") {
    throw new PipelineCancelled(runId);
  }
}

function completeActiveStepOnError(
  store: PipelineStore,
  runId: string,
  current: JsonObject,
  message: string,
): void {
  const activeStepId = store.getRun(runId)?.activeStepId;
  if (!activeStepId) return;
  const activeStep = store.getStep(activeStepId);
  if (!activeStep || activeStep.status !== "running") return;
  store.completeStep({
    id: activeStep.id,
    status: "error",
    result: current,
    error: message,
  });
}

async function executePipelineStep(input: PipelineRunnerInput & {
  runId: string;
  step: DeclarativeStep;
  current: JsonObject;
  nextStepIndex: () => number;
  targetIndex?: Map<string, number>;
  namePrefix?: string;
  trackActive?: boolean;
}): Promise<{ current: JsonObject; jumpTo?: number }> {
  const { store, registry, step } = input;
  throwIfRunCancelled(store, input.runId);
  const stepName = input.namePrefix ? `${input.namePrefix} / ${step.name}` : step.name;
  if (!shouldRunStep(input.current, step.when)) {
    const skipped = store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: step.type,
      input: input.current,
      metadata: buildPipelineStepMetadata(step),
    });
    store.completeStep({ id: skipped.id, status: "skipped", result: input.current });
    return { current: input.current };
  }

  if (step.type === "code") {
    const selected = selectInput(input.current, step.input);
    const activeStep = getActiveStep(store, input.runId, stepName, "code");
    if (activeStep?.status === "ok") {
      const raw = activeStep.output ?? activeStep.result ?? {};
      const current = activeStep.output ? assignOutput(input.current, raw, step.assign) : raw;
      return { current };
    }
    const stepRecord = activeStep ?? store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "code",
      input: selected,
      metadata: buildPipelineStepMetadata(step),
    });
    setActiveStep(input, stepRecord.id);
    const fn = registry[step.function];
    if (!fn) {
      throw new Error(`Unknown pipeline function: ${step.function}`);
    }
    const result = await fn(selected);
    throwIfRunCancelled(store, input.runId);
    assertObject(result, `step ${stepName} result`);
    const current = assignOutput(input.current, result, step.assign);
    store.completeStep({ id: stepRecord.id, status: "ok", result: current, output: result });
    return { current };
  }

  if (step.type === "block") {
    const selected = selectInput(input.current, step.input);
    const blockInput = {
      ...(step.config ?? {}),
      ...selected,
    };
    const expansion = expandPipelineBlock(step);
    const activeStep = getActiveStep(store, input.runId, stepName, "block");
    if (activeStep?.status === "ok") {
      return { current: activeStep.result ?? input.current };
    }
    const stepRecord = activeStep ?? store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "block",
      input: blockInput,
      metadata: buildPipelineStepMetadata(step),
    });
    setActiveStep(input, stepRecord.id);
    let current = assignOutput(input.current, blockInput, expansion.inputPath);
    for (const child of expansion.steps) {
      const childOutcome = await executePipelineStep({
        ...input,
        step: child,
        current,
        trackActive: false,
      });
      current = childOutcome.current;
      throwIfRunCancelled(store, input.runId);
    }
    store.completeStep({ id: stepRecord.id, status: "ok", result: current, output: current });
    return { current };
  }

  if (step.type === "loop") {
    const selected = selectInput(input.current, step.input);
    const activeStep = getActiveStep(store, input.runId, stepName, "loop");
    if (activeStep?.status === "ok") {
      const current = activeStep.result ?? input.current;
      if (!Array.isArray(step.steps)) {
        const counterPath = step.counter ?? `$.loop.${step.name.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
        const counter = resolvePath(current, counterPath);
        if (counter && typeof counter === "object" && !Array.isArray(counter) && (counter as Record<string, unknown>).done !== true) {
          if (!step.target) throw new Error(`Loop step ${stepName} requires target`);
          const jumpTo = input.targetIndex?.get(step.target);
          if (typeof jumpTo !== "number") {
            throw new Error(`Loop step ${stepName} target not found: ${step.target}`);
          }
          return { current, jumpTo };
        }
      }
      return { current };
    }
    const stepRecord = activeStep ?? store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "loop",
      input: selected,
      metadata: buildPipelineStepMetadata(step),
    });
    setActiveStep(input, stepRecord.id);
    if (Array.isArray(step.steps)) {
      const iterations = resolveIterationCount(input.current, step.iterations ?? 1);
      let current = input.current;
      const counterPath = step.counter ?? `$.loop.${step.name.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        current = assignOutput(current, { iteration, index: iteration - 1, total: iterations }, counterPath);
        for (const child of step.steps) {
          const childOutcome = await executePipelineStep({
            ...input,
            step: child,
            current,
            namePrefix: `${stepName} #${iteration}`,
            trackActive: false,
          });
          current = childOutcome.current;
          throwIfRunCancelled(store, input.runId);
        }
      }
      const result = { iterations, current };
      const next = step.assign ? assignOutput(current, result, step.assign) : current;
      store.completeStep({ id: stepRecord.id, status: "ok", result: next, output: result });
      return { current: next };
    }

    const iterations = resolveIterationCount(input.current, step.iterations ?? 1);
    const counterPath = step.counter ?? `$.loop.${step.name.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
    const historyPath = step.history;
    const historyItems = historyPath ? getHistoryItems(input.current, historyPath) : [];
    const completed = historyItems.length + 1;
    const captured = captureLoopValues(input.current, step.capture);
    let next = input.current;
    if (historyPath) {
      next = assignOutput(next, { items: [...historyItems, { iteration: completed, ...captured }] }, historyPath);
    }
    next = assignOutput(next, {
      iteration: Math.min(completed + 1, iterations),
      index: Math.min(completed, iterations - 1),
      completed,
      total: iterations,
      done: completed >= iterations,
    }, counterPath);

    let jumpTo: number | undefined;
    if (completed < iterations) {
      if (!step.target) throw new Error(`Loop step ${stepName} requires target`);
      jumpTo = input.targetIndex?.get(step.target);
      if (typeof jumpTo !== "number") {
        throw new Error(`Loop step ${stepName} target not found: ${step.target}`);
      }
    }
    store.completeStep({ id: stepRecord.id, status: "ok", result: next, output: captured });
    return { current: next, jumpTo };
  }

  if (step.type === "parallel") {
    const selected = selectInput(input.current, step.input);
    const activeStep = getActiveStep(store, input.runId, stepName, "parallel");
    if (activeStep?.status === "ok") {
      return { current: activeStep.result ?? input.current };
    }
    const stepRecord = activeStep ?? store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "parallel",
      input: selected,
      metadata: buildPipelineStepMetadata(step),
    });
    setActiveStep(input, stepRecord.id);
    const aggregate = await runParallelStep({
      ...input,
      parentStep: step,
      parentStepId: stepRecord.id,
      parentStepName: stepName,
      shouldRelaunchAgentChild: (child) => !child.wingmanSessionId || !input.sessionApiContext.manager.getSession(child.wingmanSessionId),
      runAgentChild: async ({ childStep, childRecord, selectedInput }) => {
        const token = childRecord.callbackToken ?? crypto.randomUUID();
        if (!childRecord.callbackToken) {
          input.store.setStepCallbackToken(childRecord.id, token);
        }
        try {
          const result = await runOrResumeAgentStep({
            ...input,
            stepName: childRecord.name,
            stepId: childRecord.id,
            selectedInput,
            prompt: childStep.prompt,
            callbackToken: token,
            agent: resolveStringTemplate(input.current, childStep.agent),
            model: resolveStringTemplate(input.current, childStep.model),
            directory: resolveStringTemplate(input.current, childStep.directory),
            callbackTimeoutMs: resolveDurationMs(input.current, childStep.timeoutMs, CALLBACK_TIMEOUT_MS),
          });
          input.store.completeStep({
            id: childRecord.id,
            status: "ok",
            result,
            output: result,
            wingmanSessionId: input.store.getStep(childRecord.id)?.wingmanSessionId ?? null,
          });
        } catch (error) {
          if (error instanceof PipelineHalt) {
            input.store.completeStep({
              id: childRecord.id,
              status: "needs_input",
              result: error.result,
              output: error.result,
              error: error.message,
            });
            return;
          }
          throw error;
        }
      },
    });
    throwIfRunCancelled(store, input.runId);
    const current = assignOutput(input.current, aggregate, step.assign);
    store.completeStep({ id: stepRecord.id, status: "ok", result: current, output: aggregate });
    return { current };
  }

  if (step.type === "classifier") {
    const selected = selectInput(input.current, step.input);
    const activeStep = getActiveStep(store, input.runId, stepName, "classifier");
    if (activeStep?.status === "ok") {
      const raw = activeStep.output ?? activeStep.result ?? {};
      const current = assignOutput(input.current, raw, step.assign);
      return { current };
    }
    if (activeStep?.status === "error") {
      throw new Error(activeStep.error ?? "Classifier step failed");
    }
    const stepRecord = activeStep ?? store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name: stepName,
      kind: "classifier",
      input: selected,
      metadata: buildPipelineStepMetadata(step),
    });
    setActiveStep(input, stepRecord.id);
    let result: JsonObject;
    try {
      result = await runClassifierStep({
        selectedInput: selected,
        prompt: step.prompt,
        provider: step.provider ?? "openrouter",
        model: resolveStringTemplate(input.current, step.model) ?? DEFAULT_CLASSIFIER_MODEL,
        temperature: step.temperature,
        maxTokens: step.maxTokens,
        timeoutMs: resolveDurationMs(input.current, step.timeoutMs, DEFAULT_CLASSIFIER_TIMEOUT_MS),
        attempts: resolveClassifierAttempts(input.current, step.retries),
        apiKey: resolveClassifierOpenRouterApiKey(input),
      });
      throwIfRunCancelled(store, input.runId);
    } catch (error) {
      const latest = store.getStep(stepRecord.id);
      if (latest?.status === "running") {
        store.completeStep({
          id: stepRecord.id,
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    const current = assignOutput(input.current, result, step.assign);
    store.completeStep({ id: stepRecord.id, status: "ok", result: current, output: result });
    return { current };
  }

  const selected = selectInput(input.current, step.input);
  const activeStep = getActiveStep(store, input.runId, stepName, "agent");
  if (activeStep?.status === "ok") {
    const raw = activeStep.output ?? activeStep.result ?? {};
    const current = assignOutput(input.current, raw, step.assign);
    store.completeStep({
      id: activeStep.id,
      status: "ok",
      result: current,
      output: raw,
      wingmanSessionId: activeStep.wingmanSessionId,
    });
    return { current };
  }
  if (activeStep?.status === "error") {
    throw new Error(activeStep.error ?? "Agent step failed");
  }
  if (activeStep?.status === "needs_input") {
    throw new PipelineHalt("needs_input", activeStep.output ?? activeStep.result ?? {}, "Agent step needs input");
  }
  const token = activeStep?.callbackToken ?? crypto.randomUUID();
  const stepRecord = activeStep ?? store.createStep({
    runId: input.runId,
    stepIndex: input.nextStepIndex(),
    name: stepName,
    kind: "agent",
    input: selected,
    callbackToken: token,
    metadata: buildPipelineStepMetadata(step),
  });
  if (!stepRecord.callbackToken) {
    store.setStepCallbackToken(stepRecord.id, token);
  }
  setActiveStep(input, stepRecord.id);
  let result: JsonObject;
  try {
    result = await runOrResumeAgentStep({
      ...input,
      stepName,
      stepId: stepRecord.id,
      selectedInput: selected,
      prompt: step.prompt,
      callbackToken: token,
      agent: resolveStringTemplate(input.current, step.agent),
      model: resolveStringTemplate(input.current, step.model),
      directory: resolveStringTemplate(input.current, step.directory),
      callbackTimeoutMs: resolveDurationMs(input.current, step.timeoutMs, CALLBACK_TIMEOUT_MS),
    });
    throwIfRunCancelled(store, input.runId);
  } catch (error) {
    if (error instanceof PipelineCancelled) {
      throw error;
    }
    const latest = store.getStep(stepRecord.id);
    if (latest?.status === "running") {
      store.completeStep({
        id: stepRecord.id,
        status: "error",
        result: null,
        error: error instanceof Error ? error.message : String(error),
        wingmanSessionId: latest.wingmanSessionId,
      });
    }
    throw error;
  }
  const current = assignOutput(input.current, result, step.assign);
  store.completeStep({
    id: stepRecord.id,
    status: "ok",
    result: current,
    output: result,
    wingmanSessionId: store.getStep(stepRecord.id)?.wingmanSessionId ?? null,
  });
  return { current };
}

function buildStepTargetIndex(steps: DeclarativeStep[]): Map<string, number> {
  const out = new Map<string, number>();
  steps.forEach((step, index) => {
    if (step.id) out.set(step.id, index);
    out.set(step.name, index);
  });
  return out;
}

function nextStoredStepIndex(store: PipelineStore, runId: string): number {
  const steps = store.listSteps(runId);
  return steps.reduce((max, step) => Math.max(max, step.stepIndex + 1), 0);
}

function getActiveStep(store: PipelineStore, runId: string, stepName: string, kind: StepKind): PipelineStepRecord | null {
  const run = store.getRun(runId);
  if (!run?.activeStepId) return null;
  const step = store.getStep(run.activeStepId);
  if (!step || step.runId !== runId || step.name !== stepName || step.kind !== kind) return null;
  return step;
}

function setActiveStep(input: { store: PipelineStore; runId: string; trackActive?: boolean }, stepId: string): void {
  if (input.trackActive === false) return;
  input.store.setRunActiveStep(input.runId, stepId);
}

function resolveIterationCount(current: JsonObject, value: number | string): number {
  const raw = typeof value === "string" ? resolvePath(current, value) : value;
  const count = Math.floor(Number(raw));
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(count, 200);
}

function resolveDurationMs(current: JsonObject, value: number | string | undefined, fallbackMs: number): number {
  const raw = typeof value === "string" && (value.startsWith("$.") || value === "$")
    ? resolvePath(current, value)
    : value;
  const duration = Math.floor(Number(raw));
  if (!Number.isFinite(duration) || duration < 1_000) return fallbackMs;
  return Math.min(duration, 24 * 60 * 60 * 1000);
}

function resolveClassifierAttempts(current: JsonObject, value: number | string | undefined): number {
  const raw = typeof value === "string" && (value.startsWith("$.") || value === "$")
    ? resolvePath(current, value)
    : value;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CLASSIFIER_ATTEMPTS;
  return Math.min(parsed, 5);
}

function getHistoryItems(current: JsonObject, path: string): unknown[] {
  const value = resolvePath(current, path);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items)) {
    return (value as Record<string, unknown>).items as unknown[];
  }
  return [];
}

function captureLoopValues(current: JsonObject, capture?: Record<string, string>): JsonObject {
  const out: JsonObject = {};
  if (!capture) return out;
  for (const [key, path] of Object.entries(capture)) {
    out[key] = resolvePath(current, path);
  }
  return out;
}

function resolveStringTemplate(current: JsonObject, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const resolved = value.startsWith("$.") || value === "$" ? resolvePath(current, value) : value;
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

async function runClassifierStep(input: {
  selectedInput: JsonObject;
  prompt: string;
  provider: "openrouter";
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  attempts: number;
  apiKey: string;
}): Promise<JsonObject> {
  if (input.provider !== "openrouter") {
    throw new Error(`Unsupported classifier provider: ${input.provider}`);
  }
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      const result = await callOpenRouterJsonClassifier({
        ...input,
        attempt,
      });
      assertObject(result, "classifier result");
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= input.attempts) break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`Classifier step failed after ${input.attempts} attempts: ${message}`);
}

function resolveClassifierOpenRouterApiKey(input: Pick<PipelineRunnerInput, "ownerNpub" | "sessionApiContext">): string {
  const ownerSettings = input.ownerNpub && typeof input.sessionApiContext.userSettingsStore?.getAll === "function"
    ? input.sessionApiContext.userSettingsStore.getAll(input.ownerNpub)
    : {};
  const stored = (
    ownerSettings.openrouter_api_key
    || ownerSettings.speech_api_key
    || ownerSettings.openai_api_key
    || ""
  ).trim();
  if (stored) return stored;
  const value = (
    process.env.PIPELINE_CLASSIFIER_OPENROUTER_API_KEY
    ?? process.env.OPENROUTER_API_KEY
    ?? process.env.OPENROUTER_API
    ?? ""
  ).trim();
  if (!value) {
    throw new Error("Classifier OpenRouter API key is not configured. Set speech_api_key/openrouter_api_key in user settings or set PIPELINE_CLASSIFIER_OPENROUTER_API_KEY, OPENROUTER_API_KEY, or OPENROUTER_API.");
  }
  return value;
}

async function callOpenRouterJsonClassifier(input: {
  selectedInput: JsonObject;
  prompt: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  apiKey: string;
  attempt: number;
}): Promise<JsonObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://runwingman.com",
        "x-title": "Wingman Autopilot Pipeline Classifier",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "system",
            content: [
              "You are a JSON-only classifier inside a Wingman pipeline.",
              "Return exactly one valid JSON object and no prose, no markdown, no code fence.",
              "The object must satisfy the step instruction.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              "Step instruction:",
              input.prompt,
              "",
              "Selected input:",
              JSON.stringify(input.selectedInput),
              "",
              `Attempt: ${input.attempt}`,
            ].join("\n"),
          },
        ],
        temperature: typeof input.temperature === "number" ? input.temperature : 0,
        max_tokens: typeof input.maxTokens === "number" ? input.maxTokens : 1200,
        response_format: { type: "json_object" },
      }),
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter classifier request failed (${response.status}): ${rawText.slice(0, 500)}`);
    }
    const payload = JSON.parse(rawText) as Record<string, unknown>;
    const content = extractOpenRouterMessageContent(payload);
    return parseClassifierJsonContent(content);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`OpenRouter classifier request timed out after ${Math.round(input.timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenRouterMessageContent(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenRouter classifier response did not include choices");
  }
  const first = choices[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("OpenRouter classifier response choice was invalid");
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("OpenRouter classifier response did not include a message");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    }).join("");
  }
  throw new Error("OpenRouter classifier message content was not text");
}

function parseClassifierJsonContent(content: string): JsonObject {
  const trimmed = content.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    : trimmed;
  const parsed = JSON.parse(withoutFence);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Classifier response JSON must be an object");
  }
  return parsed as JsonObject;
}

export async function acceptAgentCallback(input: {
  store: PipelineStore;
  runId: string;
  stepId: string;
  token: string | null;
  payload: unknown;
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const step = input.store.getStep(input.stepId);
  if (!step || step.runId !== input.runId) {
    return { ok: false, status: 404, body: { error: "Step not found" } };
  }
  if (!step.callbackToken || input.token !== step.callbackToken) {
    input.store.addCallback({
      stepId: input.stepId,
      accepted: false,
      payload: payloadObject(input.payload),
      error: "Invalid callback token",
    });
    return { ok: false, status: 401, body: { error: "Invalid callback token" } };
  }
  if (step.status !== "running") {
    input.store.addCallback({
      stepId: input.stepId,
      accepted: false,
      payload: payloadObject(input.payload),
      error: `Step is not accepting callbacks while ${step.status}`,
    });
    return {
      ok: false,
      status: 409,
      body: { error: `Step is not accepting callbacks while ${step.status}` },
    };
  }
  const parsed = parseAgentCallbackPayload(input.payload, input.runId, input.stepId);
  input.store.addCallback({
    stepId: input.stepId,
    accepted: parsed.ok,
    payload: payloadObject(input.payload),
    error: parsed.ok ? null : parsed.error,
  });
  if (!parsed.ok) {
    return { ok: false, status: 400, body: { error: parsed.error } };
  }
  input.store.completeStep({
    id: input.stepId,
    status: parsed.value.status,
    result: parsed.value.result,
    output: parsed.value.result,
    error: parsed.value.error ?? null,
  });
  return { ok: true, status: 200, body: { ok: true, runId: input.runId, stepId: input.stepId } };
}

async function runOrResumeAgentStep(input: PipelineRunnerInput & {
  runId: string;
  stepId: string;
  stepName: string;
  selectedInput: JsonObject;
  prompt: string;
  callbackToken: string;
  agent?: string;
  model?: string;
  directory?: string;
  callbackTimeoutMs: number;
}): Promise<JsonObject> {
  const latest = input.store.getStep(input.stepId);
  if (latest?.status === "ok") return latest.output ?? latest.result ?? {};
  if (latest?.status === "error") throw new Error(latest.error ?? "Agent step failed");
  if (latest?.status === "cancelled") throw new PipelineCancelled(input.runId);
  if (latest?.status === "needs_input") {
    throw new PipelineHalt("needs_input", latest.output ?? latest.result ?? {}, "Agent step needs input");
  }
  if (latest?.wingmanSessionId && input.sessionApiContext.manager.getSession(latest.wingmanSessionId)) {
    const result = await waitForCallbackResult(input.store, input.stepId, input.callbackTimeoutMs);
    if (result.status === "error") throw new Error(result.error ?? "Agent step failed");
    if (result.status === "cancelled") throw new PipelineCancelled(input.runId);
    if (result.status === "needs_input") throw new PipelineHalt("needs_input", result.result ?? {}, "Agent step needs input");
    return result.result ?? {};
  }
  return runAgentStep(input);
}

async function runAgentStep(input: PipelineRunnerInput & {
  runId: string;
  stepId: string;
  stepName: string;
  selectedInput: JsonObject;
  prompt: string;
  callbackToken: string;
  agent?: string;
  model?: string;
  directory?: string;
  callbackTimeoutMs: number;
}): Promise<JsonObject> {
  assertAgentInputWithinLimit(input.selectedInput, input.definition.spec.name, input.stepName);
  const sessionCtx = input.sessionApiContext;
  const agent = resolveAgent(sessionCtx, input.agent, input.defaultAgent);
  const callbackUrl = buildCallbackUrl(input.callbackOrigin, input.runId, input.stepId, input.callbackToken);
  const prompt = buildAgentPrompt({
    prompt: input.prompt,
    selectedInput: input.selectedInput,
    callbackUrl,
    callbackToken: input.callbackToken,
    runId: input.runId,
    stepId: input.stepId,
  });
  let result: { status: PipelineStatus; result: JsonObject | null; error: string | null } | null = null;
  let lastError: unknown = null;
  const maxAttempts = resolveAgentStepMaxAttempts();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const latest = input.store.getStep(input.stepId);
    if (latest?.status === "ok") {
      result = { status: "ok", result: latest.output ?? latest.result ?? {}, error: latest.error };
      break;
    }
    if (latest?.status === "needs_input") {
      result = { status: "needs_input", result: latest.output ?? latest.result ?? {}, error: latest.error };
      break;
    }
    if (latest?.status === "error") {
      throw new Error(latest.error ?? "Agent step failed");
    }
    if (latest?.status === "cancelled") {
      throw new PipelineCancelled(input.runId);
    }

    let session: SessionSnapshot | null = null;
    try {
      session = await sessionCtx.manager.createSession(
        agent,
        input.directory,
        `Pipeline ${input.stepName}${attempt > 1 ? ` retry ${attempt}` : ""}`,
        null,
        undefined,
        input.ownerNpub ?? undefined,
        {
          AGENT: true,
          role: "pipeline-step",
          goal: `Pipeline ${input.definition.spec.name}: ${input.stepName}`,
          nextAction: "stop",
          bindingType: "flow_run",
          bindingId: input.runId,
          flowRunId: input.runId,
          retryAttempt: attempt,
        },
        input.model,
      );
      input.store.setStepSession(input.stepId, session.id);
      await recordLiveSession(sessionCtx, session);

      await waitForSessionPromptReadiness({
        getSession: (sessionId) => sessionCtx.manager.getSession(sessionId) ?? null,
        getAdapter: (sessionId) => sessionCtx.manager.getAdapter(sessionId),
        sessionId: session.id,
        host: sessionCtx.agentHost,
        timeoutMs: session.agent === "codex" ? 120_000 : 60_000,
        pollIntervalMs: 250,
        requiredStablePolls: session.agent === "codex" ? 3 : 2,
        requestTimeoutMs: 750,
      });

      const delivered = await deliverSessionAgentMessage({
        agentHost: sessionCtx.agentHost,
        buildAgentUrl: sessionCtx.buildAgentUrl,
        agent: session.agent,
        port: session.port,
        content: prompt,
        type: "user",
        pm2Name: session.pm2Name,
        adapter: sessionCtx.manager.getAdapter(session.id),
      });
      if (!delivered.ok) {
        throw new Error(delivered.message);
      }

      result = await waitForCallbackResult(input.store, input.stepId, input.callbackTimeoutMs);
      break;
    } catch (error) {
      lastError = error;
      const canRetry = shouldRetryAgentStepError(error) && attempt < maxAttempts;
      if (!canRetry) {
        const latest = input.store.getStep(input.stepId);
        if (latest?.status === "running") {
          input.store.completeStep({
            id: input.stepId,
            status: "error",
            result: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    } finally {
      if (session) {
        await stopPipelineSession(sessionCtx, session.id).catch(() => undefined);
      }
    }
  }
  if (!result) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Agent step failed"));
  }
  if (result.status === "error") {
    throw new Error(result.error ?? "Agent step failed");
  }
  if (result.status === "cancelled") {
    throw new PipelineCancelled(input.runId);
  }
  if (result.status === "needs_input") {
    throw new PipelineHalt("needs_input", result.result ?? {}, "Agent step needs input");
  }
  return result.result ?? {};
}

function assertAgentInputWithinLimit(selectedInput: JsonObject, pipelineName: string, stepName: string): void {
  const maxBytes = resolveAgentInputMaxBytes();
  if (maxBytes <= 0) return;
  const bytes = new TextEncoder().encode(JSON.stringify(selectedInput)).byteLength;
  if (bytes <= maxBytes) return;
  throw new Error(
    `Agent step input is ${bytes} bytes, above ${maxBytes} byte guard for pipeline ${pipelineName}: ${stepName}. Compact step input or pass artifact references instead of full records.`,
  );
}

function resolveAgentInputMaxBytes(): number {
  const raw = process.env.PIPELINE_AGENT_INPUT_MAX_BYTES;
  if (!raw) return DEFAULT_AGENT_INPUT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_INPUT_MAX_BYTES;
  return Math.max(0, Math.floor(parsed));
}

function resolveAgentStepMaxAttempts(): number {
  const maxAttempts = parseBoundedPositiveInteger(process.env.PIPELINE_AGENT_STEP_MAX_ATTEMPTS, 1, 6);
  if (maxAttempts !== null) return maxAttempts;

  const legacyRetries = parseBoundedPositiveInteger(process.env.PIPELINE_AGENT_CALLBACK_TIMEOUT_RETRIES, 0, 5);
  if (legacyRetries !== null) return legacyRetries + 1;

  return DEFAULT_AGENT_STEP_MAX_ATTEMPTS;
}

function parseBoundedPositiveInteger(raw: string | undefined, min: number, max: number): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shouldRetryAgentStepError(error: unknown): boolean {
  if (error instanceof PipelineHalt) return false;
  return error instanceof Error || typeof error === "string";
}

async function recordLiveSession(ctx: SessionApiContext, session: SessionSnapshot): Promise<void> {
  ctx.messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
    tmuxSession: session.tmuxSession,
    tmuxWindow: session.tmuxWindow,
    targetFile: session.targetFile,
    metadata: session.metadata,
  });
  await ctx.syncSessionMessages(session.id, true);
}

async function stopPipelineSession(ctx: SessionApiContext, sessionId: string): Promise<void> {
  const stopped = await ctx.manager.stopSession(sessionId);
  if (stopped) {
    ctx.scheduleSessionArchive(sessionId, ctx.manager);
  }
}

function resolveAgent(ctx: SessionApiContext, value: string | undefined, defaultAgent?: string): AgentType {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "codex";
  if (ctx.isAgentType(normalized)) return normalized;
  if (typeof defaultAgent === "string") {
    const fallback = defaultAgent.trim().toLowerCase();
    if (ctx.isAgentType(fallback)) return fallback;
  }
  return "codex";
}

function buildCallbackUrl(origin: string, runId: string, stepId: string, token: string): string {
  const url = new URL(`/api/pipelines/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/callback`, origin);
  url.searchParams.set("token", token);
  return url.toString();
}

function buildAgentPrompt(input: {
  prompt: string;
  selectedInput: JsonObject;
  callbackUrl: string;
  callbackToken: string;
  runId: string;
  stepId: string;
}): string {
  return `You are running one step in a Wingmen pipeline.

Step instruction:
${input.prompt}

Selected input:
${JSON.stringify(input.selectedInput, null, 2)}

Completion contract:
- You are not complete until the webhook returns HTTP 200.
- POST exactly one JSON object to:
  ${input.callbackUrl}
- Header: x-wingmen-pipeline-token: ${input.callbackToken}
- Body:
  {
    "runId": "${input.runId}",
    "stepId": "${input.stepId}",
    "status": "ok",
    "result": {}
  }
- status must be "ok", "needs_input", or "error"; result must be a JSON object.
- Use "error" only when the step itself cannot be completed. For transport/auth/probe failures, fix the request and retry until HTTP 200.
- If selected input includes documentUrl and the step asks for document edits, use that reference directly.
- Do not include full document text in result; return concise summary fields, changed sections/lines, comment IDs, and status metadata only.`;
}

async function waitForCallbackResult(
  store: PipelineStore,
  stepId: string,
  timeoutMs: number,
): Promise<{ status: PipelineStatus; result: JsonObject | null; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const step = store.getStep(stepId);
    if (step && step.status !== "running") {
      return { status: step.status, result: step.output ?? step.result, error: step.error };
    }
    await new Promise((resolve) => setTimeout(resolve, CALLBACK_POLL_MS));
  }
  throw new PipelineCallbackTimeout(timeoutMs);
}

function parseAgentCallbackPayload(
  payload: unknown,
  runId: string,
  stepId: string,
): { ok: true; value: { status: PipelineStatus; result: JsonObject; error?: string | null } } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Payload must be a JSON object" };
  }
  const record = payload as Record<string, unknown>;
  if (record.runId !== runId) return { ok: false, error: "runId mismatch" };
  if (record.stepId !== stepId) return { ok: false, error: "stepId mismatch" };
  if (record.status !== "ok" && record.status !== "needs_input" && record.status !== "error") {
    return { ok: false, error: "status must be ok, needs_input, or error" };
  }
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) {
    return { ok: false, error: "result must be an object" };
  }
  return {
    ok: true,
    value: {
      status: record.status,
      result: record.result as JsonObject,
      error: typeof record.error === "string" ? record.error : null,
    },
  };
}

function payloadObject(payload: unknown): JsonObject {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonObject : { value: payload };
}
