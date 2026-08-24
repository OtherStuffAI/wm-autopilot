import type { JsonObject } from "./pipeline-store";

export type SelectorSpec =
  | string
  | {
      pick?: Record<string, string>;
      value?: JsonObject;
    };

export interface EqualsCondition {
  path: string;
  equals: unknown;
}

export type DisplayFieldFormat = "auto" | "text" | "count" | "messages" | "records" | "list" | "json";

export interface DisplayFieldSpec {
  label: string;
  path: string;
  source?: "input" | "output" | "state";
  format?: DisplayFieldFormat;
  limit?: number;
  empty?: string;
}

export interface StepDisplaySpec {
  in?: DisplayFieldSpec[];
  out?: DisplayFieldSpec[];
}

export type DeclarativeStep =
  | {
      id?: string;
      name: string;
      description?: string;
      display?: StepDisplaySpec;
      type: "block";
      block: string;
      input?: SelectorSpec;
      assign?: string;
      config?: JsonObject;
      when?: EqualsCondition;
    }
  | {
      id?: string;
      name: string;
      description?: string;
      display?: StepDisplaySpec;
      type: "code";
      function: string;
      input?: SelectorSpec;
      assign?: string;
      when?: EqualsCondition;
    }
  | {
      id?: string;
      name: string;
      description?: string;
      display?: StepDisplaySpec;
      type: "agent";
      prompt: string;
      input?: SelectorSpec;
      assign?: string;
      when?: EqualsCondition;
      agent?: string;
      model?: string;
      directory?: string;
      timeoutMs?: number | string;
    }
  | {
      id?: string;
      name: string;
      description?: string;
      display?: StepDisplaySpec;
      type: "classifier";
      prompt: string;
      input?: SelectorSpec;
      assign?: string;
      when?: EqualsCondition;
      provider?: "openrouter";
      model?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number | string;
      retries?: number | string;
    }
  | {
      id?: string;
      name: string;
      description?: string;
      display?: StepDisplaySpec;
      type: "loop";
      iterations?: number | string;
      target?: string;
      steps?: DeclarativeStep[];
      history?: string;
      capture?: Record<string, string>;
      counter?: string;
      input?: SelectorSpec;
      assign?: string;
      when?: EqualsCondition;
    }
  | {
      id?: string;
      name: string;
      description?: string;
      display?: StepDisplaySpec;
      type: "parallel";
      source: string;
      maxConcurrency?: number | string;
      agentLaunchConcurrency?: number | string;
      agentStartupRetries?: number | string;
      agentStartupRetryBackoffMs?: number | string;
      itemKey?: string;
      itemInput?: SelectorSpec;
      step: DeclarativeStep;
      input?: SelectorSpec;
      assign?: string;
      when?: EqualsCondition;
      failurePolicy?: "collect_errors" | "fail_fast";
    };

export interface DeclarativePipeline {
  name: string;
  description?: string;
  version?: string | number;
  supersedes?: string;
  defaultAgent?: string;
  default?: boolean;
  tags?: string[];
  input?: JsonObject;
  steps: DeclarativeStep[];
}

export type DeclarativeFunction = (input: JsonObject) => JsonObject | Promise<JsonObject>;
export type FunctionRegistry = Record<string, DeclarativeFunction>;

export function assertObject(value: unknown, label: string): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function selectInput(input: JsonObject, selector?: SelectorSpec): JsonObject {
  if (!selector) return input;
  if (typeof selector === "string") {
    return objectOrWrapped(resolvePath(input, selector));
  }
  if (selector.value) return selector.value;
  if (selector.pick) {
    const out: JsonObject = {};
    for (const [key, path] of Object.entries(selector.pick)) {
      out[key] = resolvePath(input, path);
    }
    return out;
  }
  return input;
}

export function assignOutput(input: JsonObject, result: JsonObject, assign?: string): JsonObject {
  if (!assign) return result;
  const next = structuredClone(input) as JsonObject;
  setPath(next, assign, result);
  return next;
}

export function shouldRunStep(input: JsonObject, condition?: EqualsCondition): boolean {
  if (!condition) return true;
  return resolvePath(input, condition.path) === condition.equals;
}

export function resolvePath(input: JsonObject, path: string): unknown {
  const normalized = path.startsWith("$.") ? path.slice(2) : path;
  if (normalized === "$" || normalized === "") return input;
  return normalized.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, input);
}

function setPath(target: JsonObject, path: string, value: unknown): void {
  const normalized = path.startsWith("$.") ? path.slice(2) : path;
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("assign path cannot be root");
  }
  let cursor: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as JsonObject;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function objectOrWrapped(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return { value };
}
