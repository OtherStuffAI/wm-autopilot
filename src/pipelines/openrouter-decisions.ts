import type { DecisionQuestion } from "./declarative";
import { assertObject } from "./declarative";
import type { JsonObject } from "./pipeline-store";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export async function runOpenRouterDecisions(input: {
  state: JsonObject;
  instructionContext?: string;
  model: string;
  questions: Record<string, DecisionQuestion>;
  timeoutMs: number;
  attempts: number;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<JsonObject> {
  if (Object.keys(input.questions).length === 0) {
    throw new Error("OpenRouter decisions classifier requires at least one question");
  }
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    const startedAt = performance.now();
    try {
      const response = await (input.fetch ?? fetch)(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
          "http-referer": "https://runwingman.com",
          "x-title": "Wingman Autopilot Pipeline Decisions",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: input.model,
          state: input.instructionContext?.trim()
            ? { instructionContext: input.instructionContext, ...input.state }
            : input.state,
          questions: input.questions,
        }),
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`OpenRouter decisions request failed (${response.status}): ${rawText.slice(0, 500)}`);
      }
      const payload = JSON.parse(rawText) as Record<string, unknown>;
      assertOpenRouterDecisionsPayload(payload);
      return {
        shadowStatus: "ok",
        authoritative: false,
        advisoryOnly: true,
        requestedModel: input.model,
        model: payload.model,
        provider: payload.provider ?? null,
        requestId: payload.id ?? null,
        latencyMs: Math.round(performance.now() - startedAt),
        usage: payload.usage,
        answers: payload.answers,
        raw: payload,
        error: null,
      };
    } catch (error) {
      lastError = error instanceof DOMException && error.name === "AbortError"
        ? new Error(`OpenRouter decisions request timed out after ${Math.round(input.timeoutMs / 1000)}s`)
        : error;
      if (attempt >= input.attempts) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`Decisions classifier failed after ${input.attempts} attempts: ${message}`);
}

export function buildShadowDecisionsError(error: unknown, requestedModel: string): JsonObject {
  return {
    shadowStatus: "error",
    authoritative: false,
    advisoryOnly: true,
    requestedModel,
    answers: {},
    raw: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function assertOpenRouterDecisionsPayload(payload: Record<string, unknown>): void {
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new Error("OpenRouter decisions response did not include a model");
  }
  assertObject(payload.answers, "OpenRouter decisions answers");
  assertObject(payload.usage, "OpenRouter decisions usage");
  for (const [id, answer] of Object.entries(payload.answers)) {
    assertObject(answer, `OpenRouter decisions answer ${id}`);
    const type = answer.type;
    if (type === "noul" && typeof answer.noul === "number") continue;
    if (type === "choice" && typeof answer.choice === "string") continue;
    if (type === "score" && typeof answer.score === "number") continue;
    throw new Error(`OpenRouter decisions answer ${id} was invalid`);
  }
}
