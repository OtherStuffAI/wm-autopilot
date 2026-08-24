import {
  assertObject,
  resolvePath,
  type DeclarativeStep,
  type FunctionRegistry,
} from "./declarative";
import { buildPipelineStepMetadata } from "./pipeline-step-metadata";
import { type JsonObject, PipelineStore, type PipelineStatus, type PipelineStepRecord } from "./pipeline-store";

const PARALLEL_POLL_MS = 1000;
const DEFAULT_AGENT_LAUNCH_CONCURRENCY = 1;
const DEFAULT_AGENT_STARTUP_RETRIES = 2;
const DEFAULT_AGENT_STARTUP_RETRY_BACKOFF_MS = 2_500;

type ParallelStep = Extract<DeclarativeStep, { type: "parallel" }>;
type AgentStep = Extract<DeclarativeStep, { type: "agent" }>;

export interface ParallelStepRunnerInput {
  store: PipelineStore;
  registry: FunctionRegistry;
  runId: string;
  current: JsonObject;
  nextStepIndex: () => number;
  parentStep: ParallelStep;
  parentStepId: string;
  parentStepName: string;
  shouldRelaunchAgentChild: (child: PipelineStepRecord) => boolean;
  runAgentChild: (input: {
    childStep: AgentStep;
    childRecord: PipelineStepRecord;
    selectedInput: JsonObject;
  }) => Promise<void>;
}

export async function runParallelStep(input: ParallelStepRunnerInput): Promise<JsonObject> {
  const itemsValue = resolvePath(input.current, input.parentStep.source);
  if (!Array.isArray(itemsValue)) {
    throw new Error(`Parallel step ${input.parentStepName} source must resolve to an array`);
  }
  const itemKeys = resolveParallelItemKeys(input.current, itemsValue, input.parentStep.itemKey);
  const maxConcurrency = resolveParallelConcurrency(input.current, input.parentStep.maxConcurrency);
  const agentLaunchConcurrency = resolveAgentLaunchConcurrency(input.current, input.parentStep.agentLaunchConcurrency, maxConcurrency);
  const agentStartupRetries = resolveAgentStartupRetries(input.current, input.parentStep.agentStartupRetries);
  const agentStartupRetryBackoffMs = resolveAgentStartupRetryBackoffMs(input.current, input.parentStep.agentStartupRetryBackoffMs);
  ensureParallelChildren(input, itemsValue, itemKeys);
  const active = new Map<string, Promise<void>>();

  while (true) {
    const children = input.store.listChildSteps(input.parentStepId);
    const failed = children.filter((child) => child.status === "error" || child.status === "needs_input");
    if (failed.length > 0 && input.parentStep.failurePolicy === "fail_fast") {
      for (const child of children.filter((entry) => entry.status === "queued")) {
        input.store.completeStep({
          id: child.id,
          status: "skipped",
          result: null,
          output: null,
          error: "Skipped after parallel fail_fast failure",
        });
      }
      throw new Error(failed[0]?.error ?? `Parallel step ${input.parentStepName} failed`);
    }
    if (children.length === itemsValue.length && children.every((child) => isTerminalStatus(child.status))) {
      return buildParallelAggregate(input.store.listChildSteps(input.parentStepId));
    }

    let pendingAgentLaunches = countPendingAgentLaunches(input, children, active);
    for (const child of children) {
      if (active.size >= maxConcurrency) break;
      if (active.has(child.id) || !shouldLaunchParallelChild(input, child)) continue;
      const childTemplate = input.parentStep.step;
      const usesAgentLaunchSlot = childTemplate.type === "agent" && !child.wingmanSessionId;
      if (usesAgentLaunchSlot && pendingAgentLaunches >= agentLaunchConcurrency) continue;
      const promise = runParallelChild(input, child, itemsValue, itemKeys)
        .catch(async (error) => {
          if (!shouldRetryAgentStartup(input, child.id, error, agentStartupRetries)) {
            throw error;
          }
          for (let attempt = 1; attempt <= agentStartupRetries; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, agentStartupRetryBackoffMs * attempt));
            try {
              const latest = input.store.getStep(child.id) ?? child;
              await runParallelChild(input, latest, itemsValue, itemKeys);
              return;
            } catch (retryError) {
              if (!shouldRetryAgentStartup(input, child.id, retryError, agentStartupRetries - attempt)) {
                throw retryError;
              }
            }
          }
          throw error;
        })
        .catch((error) => {
          const latest = input.store.getStep(child.id);
          if (latest?.status === "running" || latest?.status === "queued") {
            input.store.completeStep({
              id: child.id,
              status: "error",
              result: null,
              output: null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          active.delete(child.id);
        });
      active.set(child.id, promise);
      if (usesAgentLaunchSlot) pendingAgentLaunches += 1;
    }

    if (active.size > 0) {
      await Promise.race([
        ...active.values(),
        new Promise((resolve) => setTimeout(resolve, resolveParallelPollMs())),
      ]);
    } else {
      await new Promise((resolve) => setTimeout(resolve, resolveParallelPollMs()));
    }
  }
}

function countPendingAgentLaunches(
  input: ParallelStepRunnerInput,
  children: PipelineStepRecord[],
  active: Map<string, Promise<void>>,
): number {
  if (input.parentStep.step.type !== "agent") return 0;
  return children.filter((child) =>
    active.has(child.id) &&
    child.kind === "agent" &&
    child.status === "running" &&
    !child.wingmanSessionId &&
    !isTerminalStatus(child.status)
  ).length;
}

function ensureParallelChildren(input: ParallelStepRunnerInput, items: unknown[], itemKeys: string[]): void {
  const existingKeys = new Set(input.store.listChildSteps(input.parentStepId).map((step) => step.logicalKey ?? String(step.stepIndex)));
  items.forEach((item, index) => {
    const key = itemKeys[index] ?? String(index);
    if (existingKeys.has(key)) return;
    const child = input.parentStep.step;
    const name = `${input.parentStepName} #${index + 1} / ${child.name}`;
    const selected = selectParallelChildInput(input.current, item, index, key, input.parentStep.itemInput ?? child.input);
    input.store.createStep({
      runId: input.runId,
      stepIndex: input.nextStepIndex(),
      name,
      kind: child.type === "parallel" ? "parallel" : child.type,
      input: selected,
      status: "queued",
      parentStepId: input.parentStepId,
      logicalKey: key,
      callbackToken: child.type === "agent" ? crypto.randomUUID() : null,
      metadata: buildPipelineStepMetadata(child, {
        inputSelector: input.parentStep.itemInput ?? child.input,
        parent: {
          stepName: input.parentStepName,
          stepId: input.parentStepId,
          type: input.parentStep.type,
          source: input.parentStep.source,
          itemKey: input.parentStep.itemKey ?? null,
          logicalKey: key,
          index,
        },
      }),
    });
  });
}

function shouldLaunchParallelChild(input: ParallelStepRunnerInput, child: PipelineStepRecord): boolean {
  if (child.status === "queued") return true;
  if (child.status !== "running") return false;
  if (child.kind !== "agent") return true;
  return input.shouldRelaunchAgentChild(child);
}

async function runParallelChild(
  input: ParallelStepRunnerInput,
  childRecord: PipelineStepRecord,
  items: unknown[],
  itemKeys: string[],
): Promise<void> {
  const child = input.parentStep.step;
  const key = childRecord.logicalKey ?? "";
  const index = itemKeys.indexOf(key);
  const item = items[index] ?? null;
  const selected = selectParallelChildInput(input.current, item, index, key, input.parentStep.itemInput ?? child.input);
  const runningChild = childRecord.status === "queued" ? input.store.startStep(childRecord.id) : childRecord;

  if (child.type === "code") {
    const fn = input.registry[child.function];
    if (!fn) throw new Error(`Unknown pipeline function: ${child.function}`);
    const result = await fn(selected);
    assertObject(result, `parallel child ${runningChild.name} result`);
    input.store.completeStep({ id: runningChild.id, status: "ok", result, output: result });
    return;
  }

  if (child.type !== "agent") {
    throw new Error(`Parallel step ${input.parentStep.name} only supports code and agent child steps`);
  }

  await input.runAgentChild({
    childStep: child,
    childRecord: runningChild,
    selectedInput: selected,
  });
}

function buildParallelAggregate(children: PipelineStepRecord[]): JsonObject {
  const items = children.map((child, index) => ({
    key: child.logicalKey ?? String(index),
    index,
    status: child.status,
    result: child.output ?? child.result ?? {},
    error: child.error,
    stepId: child.id,
    wingmanSessionId: child.wingmanSessionId,
  }));
  return {
    total: children.length,
    ok: children.filter((child) => child.status === "ok").length,
    error: children.filter((child) => child.status === "error").length,
    needsInput: children.filter((child) => child.status === "needs_input").length,
    items,
  };
}

function resolveParallelConcurrency(current: JsonObject, value: number | string | undefined): number {
  const configuredLimit = Math.floor(Number(process.env.PIPELINE_MAX_PARALLEL_SESSIONS ?? 21));
  const globalLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 21;
  const raw = typeof value === "string" ? resolvePath(current, value) : value;
  const requested = Math.floor(Number(raw ?? globalLimit));
  const perStep = Number.isFinite(requested) && requested > 0 ? requested : globalLimit;
  return Math.max(1, Math.min(perStep, globalLimit, 200));
}

function resolveAgentLaunchConcurrency(current: JsonObject, value: number | string | undefined, maxConcurrency: number): number {
  const configuredLimit = Math.floor(Number(process.env.PIPELINE_PARALLEL_AGENT_LAUNCH_CONCURRENCY ?? DEFAULT_AGENT_LAUNCH_CONCURRENCY));
  const globalLimit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_AGENT_LAUNCH_CONCURRENCY;
  const raw = typeof value === "string" ? resolvePath(current, value) : value;
  const requested = Math.floor(Number(raw ?? globalLimit));
  const perStep = Number.isFinite(requested) && requested > 0 ? requested : globalLimit;
  return Math.max(1, Math.min(perStep, maxConcurrency, 50));
}

function resolveAgentStartupRetries(current: JsonObject, value: number | string | undefined): number {
  const configuredLimit = Math.floor(Number(process.env.PIPELINE_PARALLEL_AGENT_START_RETRIES ?? DEFAULT_AGENT_STARTUP_RETRIES));
  const globalLimit = Number.isFinite(configuredLimit) && configuredLimit >= 0 ? configuredLimit : DEFAULT_AGENT_STARTUP_RETRIES;
  const raw = typeof value === "string" ? resolvePath(current, value) : value;
  const requested = Math.floor(Number(raw ?? globalLimit));
  const perStep = Number.isFinite(requested) && requested >= 0 ? requested : globalLimit;
  return Math.max(0, Math.min(perStep, 10));
}

function resolveAgentStartupRetryBackoffMs(current: JsonObject, value: number | string | undefined): number {
  const configuredLimit = Math.floor(Number(process.env.PIPELINE_PARALLEL_AGENT_START_RETRY_BACKOFF_MS ?? DEFAULT_AGENT_STARTUP_RETRY_BACKOFF_MS));
  const globalLimit = Number.isFinite(configuredLimit) && configuredLimit >= 0 ? configuredLimit : DEFAULT_AGENT_STARTUP_RETRY_BACKOFF_MS;
  const raw = typeof value === "string" ? resolvePath(current, value) : value;
  const requested = Math.floor(Number(raw ?? globalLimit));
  const perStep = Number.isFinite(requested) && requested >= 0 ? requested : globalLimit;
  return Math.max(0, Math.min(perStep, 60_000));
}

function resolveParallelPollMs(): number {
  const requested = Math.floor(Number(process.env.PIPELINE_PARALLEL_POLL_MS ?? PARALLEL_POLL_MS));
  return Number.isFinite(requested) && requested > 0 ? Math.min(requested, PARALLEL_POLL_MS) : PARALLEL_POLL_MS;
}

function shouldRetryAgentStartup(
  input: ParallelStepRunnerInput,
  childId: string,
  error: unknown,
  retriesRemaining: number,
): boolean {
  if (retriesRemaining <= 0 || input.parentStep.step.type !== "agent") return false;
  const latest = input.store.getStep(childId);
  if (latest?.wingmanSessionId) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /\bPM2 process\b.+\bfailed (?:to start within timeout|during startup)\b/.test(message);
}

function resolveParallelItemKey(current: JsonObject, item: unknown, index: number, itemKey?: string): string {
  if (!itemKey) return String(index);
  const value = resolveScopedPath({ current, item, index, key: String(index) }, itemKey);
  if (value === null || value === undefined || value === "") return String(index);
  return String(value);
}

function resolveParallelItemKeys(current: JsonObject, items: unknown[], itemKey?: string): string[] {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const base = resolveParallelItemKey(current, item, index, itemKey);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count + 1}`;
  });
}

function selectParallelChildInput(
  current: JsonObject,
  item: unknown,
  index: number,
  key: string,
  selector?: DeclarativeStep["input"],
): JsonObject {
  const scope = { current, item, index, key };
  if (!selector) return { item, index, key };
  if (typeof selector === "string") return objectOrWrappedParallel(resolveScopedPath(scope, selector));
  if (selector.value) return selector.value;
  if (selector.pick) {
    const out: JsonObject = {};
    for (const [field, path] of Object.entries(selector.pick)) {
      out[field] = resolveScopedPath(scope, path);
    }
    return out;
  }
  return { item, index, key };
}

function resolveScopedPath(scope: { current: JsonObject; item: unknown; index: number; key: string }, path: string): unknown {
  if (path === "$item") return scope.item;
  if (path.startsWith("$item.")) return resolveValuePath(scope.item, path.slice("$item.".length));
  if (path === "$index") return scope.index;
  if (path === "$key") return scope.key;
  return resolvePath(scope.current, path);
}

function resolveValuePath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((cursor, key) => {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    return (cursor as Record<string, unknown>)[key];
  }, value);
}

function objectOrWrappedParallel(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return { value };
}

function isTerminalStatus(status: PipelineStatus): boolean {
  return status === "ok" || status === "needs_input" || status === "error" || status === "skipped" || status === "cancelled";
}
