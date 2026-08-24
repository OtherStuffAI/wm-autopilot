import { z } from "zod";

const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";
const DEFAULT_TRANSCRIPTION_BASE_URL = "https://api.openai.com/v1";

const transcriptionConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
});

export type AudioTranscriptionConfig = z.infer<typeof transcriptionConfigSchema>;

export type TranscribeAudioInput = {
  audio: Blob;
  filename: string;
  mimeType: string | null;
};

function trimTrailingPunctuation(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function resolveAudioTranscriptionConfig(): AudioTranscriptionConfig | null {
  const apiKey =
    Bun.env.WINGMAN_TRANSCRIPTION_API_KEY?.trim() ||
    Bun.env.OPENAI_API_KEY?.trim() ||
    Bun.env.CODEX_API_KEY?.trim() ||
    "";
  if (!apiKey) {
    return null;
  }

  const baseUrl =
    Bun.env.WINGMAN_TRANSCRIPTION_BASE_URL?.trim() ||
    Bun.env.OPENAI_BASE_URL?.trim() ||
    DEFAULT_TRANSCRIPTION_BASE_URL;

  const model =
    Bun.env.WINGMAN_TRANSCRIPTION_MODEL?.trim() ||
    Bun.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ||
    DEFAULT_TRANSCRIPTION_MODEL;

  const parsed = transcriptionConfigSchema.safeParse({
    apiKey,
    baseUrl,
    model,
  });
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

function extractOpenAIErrorMessage(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "Transcription request failed";
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
    // Fall through to raw text handling below.
  }
  return trimmed;
}

export async function transcribeAudioFile(input: TranscribeAudioInput): Promise<string> {
  const config = resolveAudioTranscriptionConfig();
  if (!config) {
    throw new Error("No transcription API key configured");
  }

  const form = new FormData();
  form.append("file", input.audio, input.filename);
  form.append("model", config.model);
  form.append("response_format", "text");

  const baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const response = await fetch(new URL("audio/transcriptions", baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: form,
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(extractOpenAIErrorMessage(rawBody));
  }

  try {
    const parsed = JSON.parse(rawBody) as { text?: unknown } | null;
    if (parsed && typeof parsed.text === "string") {
      return trimTrailingPunctuation(parsed.text);
    }
  } catch {
    // The response format may be plain text.
  }

  return trimTrailingPunctuation(rawBody);
}
