import { z } from "zod";

const DEFAULT_SPEECH_MODEL = "tts-1";
const DEFAULT_SPEECH_VOICE = "alloy";
const DEFAULT_SPEECH_FORMAT = "mp3";
const DEFAULT_SPEECH_BASE_URL = "https://api.openai.com/v1";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_REGEX = new RegExp(UUID_PATTERN, "gi");
const MARKDOWN_REFERENCE_LINK_REGEX = new RegExp(`!?@?\\[([^\\]\\n]+)\\]\\((?:mention:[^)]+|[^)]*${UUID_PATTERN}[^)]*)\\)`, "gi");
const MARKDOWN_LINK_REGEX = /!?@?\[([^\]\n]+)\]\([^)]+\)/g;
const PARENTHESIZED_REFERENCE_REGEX = new RegExp(`\\s*\\((?:mention:[^)]+|[^)]*${UUID_PATTERN}[^)]*)\\)`, "gi");
const BARE_MENTION_REFERENCE_REGEX = new RegExp(`\\bmention:[\\w:-]*${UUID_PATTERN}\\b`, "gi");

const speechConfigSchema = z.object({
  provider: z.enum(["openrouter", "local"]).default("openrouter"),
  apiKey: z.string().optional(),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  voice: z.string().min(1),
  format: z.string().min(1),
});

export type AudioSpeechConfig = z.infer<typeof speechConfigSchema>;

export type GenerateSpeechInput = {
  text: string;
  voice?: string | null;
  config?: Partial<AudioSpeechConfig> | null;
};

export function normalizeSpeechText(value: string): string {
  return value
    .replace(MARKDOWN_REFERENCE_LINK_REGEX, "$1")
    .replace(MARKDOWN_LINK_REGEX, "$1")
    .replace(PARENTHESIZED_REFERENCE_REGEX, "")
    .replace(BARE_MENTION_REFERENCE_REGEX, "")
    .replace(UUID_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProviderErrorMessage(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "Speech request failed";
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

export function resolveAudioSpeechConfig(overrides: Partial<AudioSpeechConfig> | null = null): AudioSpeechConfig | null {
  const provider = overrides?.provider === "local" ? "local" : "openrouter";
  const apiKey =
    overrides?.apiKey?.trim() ||
    Bun.env.WINGMAN_SPEECH_API_KEY?.trim() ||
    Bun.env.OPENAI_API_KEY?.trim() ||
    Bun.env.CODEX_API_KEY?.trim() ||
    "";
  if (!apiKey && provider !== "local") {
    return null;
  }

  const baseUrl =
    overrides?.baseUrl?.trim() ||
    Bun.env.WINGMAN_SPEECH_BASE_URL?.trim() ||
    Bun.env.OPENAI_BASE_URL?.trim() ||
    DEFAULT_SPEECH_BASE_URL;

  const model =
    overrides?.model?.trim() ||
    Bun.env.WINGMAN_SPEECH_MODEL?.trim() ||
    Bun.env.OPENAI_SPEECH_MODEL?.trim() ||
    DEFAULT_SPEECH_MODEL;

  const voice =
    overrides?.voice?.trim() ||
    Bun.env.WINGMAN_SPEECH_VOICE?.trim() ||
    Bun.env.OPENAI_SPEECH_VOICE?.trim() ||
    DEFAULT_SPEECH_VOICE;

  const format =
    overrides?.format?.trim() ||
    Bun.env.WINGMAN_SPEECH_FORMAT?.trim() ||
    DEFAULT_SPEECH_FORMAT;

  const parsed = speechConfigSchema.safeParse({
    provider,
    apiKey: apiKey || undefined,
    baseUrl,
    model,
    voice,
    format,
  });
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

export function resolveSpeechMimeType(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized === "opus") return "audio/ogg";
  if (normalized === "aac") return "audio/aac";
  if (normalized === "flac") return "audio/flac";
  if (normalized === "wav") return "audio/wav";
  if (normalized === "pcm") return "audio/L16";
  return "audio/mpeg";
}

export function resolveSpeechExtension(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized === "opus") return ".ogg";
  if (["aac", "flac", "wav"].includes(normalized)) return `.${normalized}`;
  if (normalized === "pcm") return ".pcm";
  return ".mp3";
}

export async function generateSpeechAudio(input: GenerateSpeechInput): Promise<{
  audio: Uint8Array;
  mimeType: string;
  model: string;
  voice: string;
  format: string;
}> {
  const config = resolveAudioSpeechConfig(input.config ?? null);
  if (!config) {
    throw new Error("No speech API key configured");
  }

  const text = normalizeSpeechText(input.text);
  if (!text) {
    throw new Error("Speech text is required");
  }

  const voice = typeof input.voice === "string" && input.voice.trim() ? input.voice.trim() : config.voice;
  const baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(new URL("audio/speech", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice,
      response_format: config.format,
    }),
  });

  if (!response.ok) {
    throw new Error(extractProviderErrorMessage(await response.text()));
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mimeType: resolveSpeechMimeType(config.format),
    model: config.model,
    voice,
    format: config.format,
  };
}
