const OPENROUTER_CHAT_COMPLETIONS_PATH = "chat/completions";
const MAX_PROMPT_CHARS = 2_000;
const MAX_RESPONSE_CHARS = 8_000;

export type SpeechSummaryConfig = {
  apiKey?: string;
  baseUrl: string;
  model: string;
};

export type GenerateSpeechSummaryInput = {
  userPrompt: string;
  agentResponse: string;
  config: SpeechSummaryConfig;
};

function normalizeInput(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractProviderErrorMessage(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "Speech summary request failed";
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown> & {
      error?: unknown;
      message?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      const nestedError = parsed.error;
      if (nestedError && typeof nestedError === "object") {
        const nestedErrorRecord = nestedError as Record<string, unknown>;
        if (typeof nestedErrorRecord.message === "string") {
          return nestedErrorRecord.message;
        }
      }
      if (typeof parsed.message === "string" && parsed.message) {
        return parsed.message;
      }
      if (typeof parsed.error === "string" && parsed.error) {
        return parsed.error;
      }
    }
  } catch {
    // Fall through to raw text handling.
  }
  return trimmed;
}

function extractSummaryText(data: unknown): string {
  const choices = (data as { choices?: unknown[] } | null)?.choices;
  if (!Array.isArray(choices)) {
    return "";
  }
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
  const content = first?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join(" ");
  }
  if (typeof first?.text === "string") {
    return first.text;
  }
  return "";
}

function buildSummaryPrompt(userPrompt: string, agentResponse: string): string {
  return [
    "Create a concise spoken summary for someone listening on earbuds.",
    "Use first person as the assistant.",
    "Mention the user's request only when it helps context.",
    "Keep it under 55 words.",
    "Do not say markdown, bullets, code fences, or formatting instructions.",
    "",
    `User request: ${normalizeInput(userPrompt, MAX_PROMPT_CHARS) || "Not available."}`,
    `Assistant response: ${normalizeInput(agentResponse, MAX_RESPONSE_CHARS)}`,
  ].join("\n");
}

export async function generateSpeechSummary(input: GenerateSpeechSummaryInput): Promise<string> {
  const agentResponse = normalizeInput(input.agentResponse, MAX_RESPONSE_CHARS);
  if (!agentResponse) {
    throw new Error("Agent response is required");
  }

  const baseUrl = input.config.baseUrl.endsWith("/") ? input.config.baseUrl : `${input.config.baseUrl}/`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (input.config.apiKey?.trim()) {
    headers.Authorization = `Bearer ${input.config.apiKey.trim()}`;
  }
  const response = await fetch(new URL(OPENROUTER_CHAT_COMPLETIONS_PATH, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.config.model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: "You write short natural spoken summaries of agent replies. Return only the final spoken summary. Do not explain your reasoning.",
        },
        {
          role: "user",
          content: buildSummaryPrompt(input.userPrompt, agentResponse),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(extractProviderErrorMessage(await response.text()));
  }

  const summary = normalizeInput(extractSummaryText(await response.json()), 700);
  if (!summary) {
    throw new Error("Speech summary returned no text");
  }
  return summary;
}
