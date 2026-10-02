import { assertObject } from "./declarative";
import type { JsonObject } from "./pipeline-store";
import { redactPipelineValue } from "./pipeline-evidence-redaction";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function runClassifierStep(input: {
  selectedInput: JsonObject;
  prompt: string;
  provider: "openrouter";
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  attempts: number;
  apiKey: string;
  captureRequest?: (value: JsonObject, attempt: number) => unknown;
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
  throw new Error(String(redactPipelineValue(`Classifier step failed after ${input.attempts} attempts: ${message}`, [input.apiKey]).value));
}

async function callOpenRouterJsonClassifier(input: {
  selectedInput: JsonObject;
  prompt: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  apiKey: string;
  captureRequest?: (value: JsonObject, attempt: number) => unknown;
  attempt: number;
}): Promise<JsonObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const body = {
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
    };
    input.captureRequest?.(body, input.attempt);
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://runwingman.com",
        "x-title": "Wingman Autopilot Pipeline Classifier",
      },
      signal: controller.signal,
      body: JSON.stringify(body),
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
