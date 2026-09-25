import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { JsonObject } from "../pipeline-store";
import { resolveExecutable } from "./command-runner";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AudioEngineConfig {
  ffmpegCommand: string;
  sttCommand: string;
  sttModel: string;
  diarizationCommand: string;
  diarizationModel: string;
  artifactRoot: string;
  allowedLocalRoots: string[];
  artifactRetentionHours: number;
}

export function readAudioEngineConfig(env: Record<string, string | undefined> = process.env): AudioEngineConfig {
  return {
    ffmpegCommand: env.AUDIO_FFMPEG_COMMAND?.trim() || "ffmpeg",
    sttCommand: env.AUDIO_STT_COMMAND?.trim() || "",
    sttModel: env.AUDIO_STT_MODEL?.trim() || "",
    diarizationCommand: env.AUDIO_DIARIZATION_COMMAND?.trim() || "",
    diarizationModel: env.AUDIO_DIARIZATION_MODEL?.trim() || "",
    artifactRoot: resolve(expandHome(env.AUDIO_ARTIFACT_ROOT?.trim() || "data/audio-understanding")),
    allowedLocalRoots: (env.AUDIO_ALLOWED_LOCAL_ROOTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(expandHome(entry))),
    artifactRetentionHours: positiveNumber(env.AUDIO_ARTIFACT_RETENTION_HOURS, 168),
  };
}

export async function inspectAudioCapabilities(config: AudioEngineConfig): Promise<JsonObject> {
  const [ffmpegPath, sttPath, diarizationPath] = await Promise.all([
    resolveExecutable(config.ffmpegCommand),
    resolveExecutable(config.sttCommand),
    resolveExecutable(config.diarizationCommand),
  ]);
  const missing: string[] = [];
  if (!ffmpegPath) missing.push("ffmpeg binary (AUDIO_FFMPEG_COMMAND)");
  if (!sttPath) missing.push("timestamped STT binary (AUDIO_STT_COMMAND)");
  if (!config.sttModel || !existsSync(config.sttModel)) missing.push("STT model (AUDIO_STT_MODEL)");
  if (!diarizationPath) missing.push("Nemotron diarization binary (AUDIO_DIARIZATION_COMMAND)");
  if (!config.diarizationModel || !existsSync(config.diarizationModel)) missing.push("Nemotron diarization model (AUDIO_DIARIZATION_MODEL)");
  return {
    ready: missing.length === 0,
    missing,
    engines: {
      normalisation: { engine: "ffmpeg", command: ffmpegPath },
      stt: { engine: "local-timestamped-stt", command: sttPath, model: config.sttModel || null },
      diarization: { engine: "nemotron-3-diarization", command: diarizationPath, model: config.diarizationModel || null },
    },
  };
}

export function validateAudioRequest(input: JsonObject, config: AudioEngineConfig): JsonObject {
  const audioRef = requiredText(input.audioRef, "audioRef");
  if (/^(?:data:|blob:)/i.test(audioRef) || /^[A-Za-z0-9+/]{256,}={0,2}$/.test(audioRef)) {
    throw new Error("audioRef must be a reference; binary/base64 audio is not permitted in pipeline state");
  }
  const returnTo = optionalObject(input.returnTo, "returnTo");
  const options = optionalObject(input.options, "options") ?? {};
  const glossary = Array.isArray(options.glossary)
    ? options.glossary.map((item) => requiredText(item, "options.glossary item"))
    : [];
  if (glossary.length > 200) throw new Error("options.glossary supports at most 200 entries");
  const speakerMapping = optionalObject(options.speakerMapping, "options.speakerMapping") ?? {};
  const source = resolveAudioReference(audioRef, config.allowedLocalRoots);
  if (!returnTo) throw new Error("returnTo is required");
  validateReturnRoute(returnTo);
  return {
    audioRef,
    source,
    returnTo: returnTo ?? null,
    options: {
      language: typeof options.language === "string" && options.language.trim() ? options.language.trim() : "auto",
      speakerCount: options.speakerCount === "auto" || options.speakerCount === undefined
        ? "auto"
        : boundedInteger(options.speakerCount, "options.speakerCount", 1, 8),
      glossary,
      speakerMapping,
      correctTranscript: options.correctTranscript === true,
      proofreadTranscript: options.proofreadTranscript === true,
      summarise: options.summarise === true,
      extractGraph: options.extractGraph === true,
      downstreamPipelineId: typeof options.downstreamPipelineId === "string" && options.downstreamPipelineId.trim()
        ? options.downstreamPipelineId.trim()
        : null,
    },
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAudioReference(audioRef: string, allowedRoots: string[]): JsonObject {
  if (audioRef.startsWith("storage://")) {
    const objectId = audioRef.slice("storage://".length);
    if (!UUID.test(objectId)) throw new Error("audioRef storage object id must be a UUID");
    return { kind: "tower-storage", ref: audioRef, objectId };
  }
  if (audioRef.startsWith("file://")) throw new Error("file:// audio references are not permitted; use an allowed absolute path");
  if (!isAbsolute(audioRef)) throw new Error("audioRef must be storage://<uuid> or an explicitly allowed absolute local path");
  const path = normalize(resolve(audioRef));
  const allowed = allowedRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
  if (!allowed) throw new Error("Local audioRef is outside AUDIO_ALLOWED_LOCAL_ROOTS");
  if (!existsSync(path)) throw new Error(`Local audioRef does not exist: ${path}`);
  return { kind: "local", ref: audioRef, path };
}

function validateReturnRoute(route: JsonObject): void {
  for (const field of ["workspaceId", "scopeId", "channelId", "threadId"] as const) {
    const value = requiredText(route[field], `returnTo.${field}`);
    if (!UUID.test(value)) throw new Error(`returnTo.${field} must be a UUID`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalObject(value: unknown, label: string): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
}
