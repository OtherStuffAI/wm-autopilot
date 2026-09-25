import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JsonObject } from "../pipeline-store";
import type { AudioEngineConfig } from "./config";
import type { AudioWord, TranscriptCorrection, TranscriptTurn } from "./types";
import { getAudioUnderstandingAdapters } from "./adapters";

export function correctTranscript(input: JsonObject): JsonObject {
  const transcript = objectValue(input.transcript);
  const options = objectValue(input.options);
  const glossary = Array.isArray(options.glossary)
    ? options.glossary.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  const enabled = options.correctTranscript === true;
  const words = (Array.isArray(transcript.words) ? transcript.words : []).map((entry) => ({ ...objectValue(entry) })) as AudioWord[];
  const corrections: TranscriptCorrection[] = [];
  if (enabled) {
    words.forEach((word, wordIndex) => {
      const match = bestGlossaryMatch(word.text, glossary);
      if (!match || match.confidence < 0.8 || match.newText === word.text) return;
      corrections.push({
        oldText: word.text,
        newText: match.newText,
        reason: "High-confidence glossary match",
        source: "caller-glossary",
        confidence: match.confidence,
        wordIndex,
      });
      word.text = match.newText;
    });
  }
  const turns = rebuildTurns(Array.isArray(transcript.turns) ? transcript.turns : [], words);
  return {
    ...transcript,
    words,
    turns,
    rawTranscript: String(transcript.rawTranscript ?? ""),
    correctedTranscript: turns.map((turn) => turn.text).join(" "),
    corrections,
    correctionPolicy: {
      enabled,
      source: "caller-glossary",
      automaticThreshold: 0.8,
      lowConfidenceAction: "unchanged",
    },
  };
}

export function buildCanonicalPackage(input: JsonObject): JsonObject {
  const request = objectValue(input.request);
  const corrected = objectValue(input.corrected);
  const normalised = objectValue(input.normalised);
  const stt = objectValue(input.stt);
  const diarization = objectValue(input.diarization);
  const proofread = objectValue(input.proofread);
  const summary = objectValue(input.summary);
  const words = Array.isArray(corrected.words) ? corrected.words : [];
  const durationSeconds = words.reduce((maximum, entry) => Math.max(maximum, Number(objectValue(entry).end) || 0), 0);
  const processingSeconds = [normalised, stt, diarization]
    .reduce((total, stage) => total + (Number(stage.processingSeconds) || 0), 0);
  return {
    schemaVersion: 1,
    audioRef: request.audioRef ?? null,
    speakers: Array.isArray(corrected.speakers) ? corrected.speakers : [],
    words,
    turns: Array.isArray(corrected.turns) ? corrected.turns : [],
    rawTranscript: String(corrected.rawTranscript ?? ""),
    correctedTranscript: String(corrected.correctedTranscript ?? corrected.rawTranscript ?? ""),
    corrections: Array.isArray(corrected.corrections) ? corrected.corrections : [],
    agentProofing: Object.keys(proofread).length > 0 ? proofread : null,
    summary: Object.keys(summary).length > 0 ? summary : null,
    artifacts: [],
    engines: {
      normalisation: { name: "ffmpeg", sampleRateHz: normalised.sampleRateHz ?? null },
      stt: stt.engine ?? null,
      diarization: diarization.engine ?? null,
    },
    metrics: {
      durationSeconds,
      processingSeconds: Number(processingSeconds.toFixed(3)),
      realTimeFactor: durationSeconds > 0 ? Number((processingSeconds / durationSeconds).toFixed(3)) : null,
      wordCount: words.length,
      speakerCount: Array.isArray(corrected.speakers) ? corrected.speakers.length : 0,
    },
    downstream: objectValue(request.options).downstreamPipelineId
      ? { requestedPipelineId: objectValue(request.options).downstreamPipelineId, status: "not-started" }
      : null,
    warnings: collectWarnings(corrected),
  };
}

export async function persistTranscriptArtifacts(input: JsonObject, config: AudioEngineConfig): Promise<JsonObject> {
  const transcriptPackage = { ...objectValue(input.transcriptPackage), downstream: objectValue(input.downstream) };
  const artifactId = randomUUID();
  const directory = join(config.artifactRoot, artifactId);
  await mkdir(directory, { recursive: true });
  const json = `${JSON.stringify(transcriptPackage, null, 2)}\n`;
  const text = formatTranscriptText(transcriptPackage);
  const artifacts = await Promise.all([
    writeArtifact(directory, "transcript.json", "application/json", json),
    writeArtifact(directory, "transcript.txt", "text/plain; charset=utf-8", text),
  ]);
  await cleanupExpiredArtifacts(config.artifactRoot, config.artifactRetentionHours, artifactId);
  const route = objectValue(objectValue(input.request).returnTo);
  const publisher = getAudioUnderstandingAdapters().publishArtifacts;
  const published = publisher ? await publisher({ artifacts, route }) : artifacts;
  return {
    ...transcriptPackage,
    artifacts: published,
    artifactPersistence: {
      authority: publisher ? "tower-storage" : "autopilot-local",
      towerUploadStatus: publisher ? "complete" : "not-configured",
      retentionHours: config.artifactRetentionHours,
    },
  };
}

export async function invokeOptionalConsumers(input: JsonObject): Promise<JsonObject> {
  const request = objectValue(input.request);
  const options = objectValue(request.options);
  const transcript = objectValue(input.result);
  const outcomes: JsonObject = {
    proofread: options.proofreadTranscript === true ? objectValue(input.proofread) : { status: "skipped" },
    summary: options.summarise === true ? objectValue(input.summary) : { status: "skipped" },
    graph: options.extractGraph === true ? objectValue(input.graph) : { status: "skipped" },
    pipeline: { status: "skipped" },
  };
  const pipelineId = typeof options.downstreamPipelineId === "string" ? options.downstreamPipelineId : "";
  if (pipelineId) {
    const invoke = getAudioUnderstandingAdapters().invokeDownstream;
    if (!invoke) throw new Error("A downstream pipeline was requested but the pipeline invocation adapter is unavailable");
    outcomes.pipeline = await invoke({ pipelineId, transcript, route: objectValue(request.returnTo) });
  }
  return outcomes;
}

export function prepareDeliveryPayload(input: JsonObject): JsonObject {
  const request = objectValue(input.request);
  const route = objectValue(request.returnTo);
  const result = objectValue(input.result);
  if (Object.keys(route).length === 0) return { requested: false, delivered: false, reason: "returnTo_not_supplied" };
  for (const field of ["workspaceId", "scopeId", "channelId", "threadId"] as const) {
    if (typeof route[field] !== "string" || !route[field]) throw new Error(`returnTo.${field} is required for delivery`);
  }
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts.map((item) => objectValue(item).ref).filter(Boolean) : [];
  const summary = objectValue(result.summary);
  const message = [
    `Audio understanding complete: ${Number(objectValue(result.metrics).wordCount) || 0} words across ${Number(objectValue(result.metrics).speakerCount) || 0} speakers.`,
    typeof summary.summary === "string" && summary.summary.trim() ? summary.summary.trim() : null,
    artifacts.length > 0 ? `Artifacts: ${artifacts.join(", ")}` : null,
  ].filter(Boolean).join("\n\n");
  const canonicalHash = createHash("sha256").update(JSON.stringify({ route, artifacts, transcript: result.correctedTranscript })).digest("hex");
  return { requested: true, delivered: false, route, message, artifacts, idempotencyKey: `audio-understanding:${canonicalHash}` };
}

function bestGlossaryMatch(text: string, glossary: string[]): { newText: string; confidence: number } | null {
  const punctuation = text.match(/^[^\p{L}\p{N}]*(.*?)[^\p{L}\p{N}]*$/u)?.[1] ?? text;
  const normalized = punctuation.toLocaleLowerCase();
  if (!normalized || glossary.some((entry) => entry === text)) return null;
  let best: { newText: string; confidence: number } | null = null;
  for (const entry of glossary) {
    const target = entry.trim();
    if (!target || /\s/.test(target)) continue;
    const distance = levenshtein(normalized, target.toLocaleLowerCase());
    const confidence = 1 - distance / Math.max(normalized.length, target.length, 1);
    if ((!best || confidence > best.confidence) && distance <= 2) best = { newText: preservePunctuation(text, target), confidence };
  }
  return best;
}

function rebuildTurns(turns: unknown[], words: AudioWord[]): TranscriptTurn[] {
  return turns.map((entry) => {
    const turn = objectValue(entry);
    const indexes = Array.isArray(turn.wordIndexes) ? turn.wordIndexes.map(Number).filter(Number.isInteger) : [];
    return {
      ...turn,
      text: indexes.map((index) => words[index]?.text ?? "").filter(Boolean).join(" "),
    } as TranscriptTurn;
  });
}

async function writeArtifact(directory: string, fileName: string, contentType: string, content: string) {
  const path = join(directory, fileName);
  await writeFile(path, content, { flag: "wx" });
  return {
    kind: basename(fileName, `.${fileName.split(".").pop()}`),
    ref: `file://${path}`,
    contentType,
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function formatTranscriptText(transcriptPackage: JsonObject): string {
  const turns = Array.isArray(transcriptPackage.turns) ? transcriptPackage.turns : [];
  return `${turns.map((entry) => {
    const turn = objectValue(entry);
    return `[${formatTime(Number(turn.start) || 0)}] ${String(turn.speaker ?? "Speaker")}: ${String(turn.text ?? "")}`;
  }).join("\n")}\n`;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function preservePunctuation(source: string, replacement: string): string {
  const leading = source.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
  const trailing = source.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? "";
  return `${leading}${replacement}${trailing}`;
}

function levenshtein(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0]!;
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex]!;
      row[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal
        : Math.min(row[rightIndex - 1]!, row[rightIndex]!, diagonal) + 1;
      diagonal = previous;
    }
  }
  return row[right.length]!;
}

function collectWarnings(corrected: JsonObject): string[] {
  const words = Array.isArray(corrected.words) ? corrected.words : [];
  const warnings: string[] = [];
  if (words.some((entry) => objectValue(objectValue(entry).attribution).method === "nearest-segment-gap")) {
    warnings.push("Some words fell in diarization gaps and were assigned to the nearest segment.");
  }
  if (words.some((entry) => Number(objectValue(objectValue(entry).attribution).competingSegments) > 1)) {
    warnings.push("Some words overlapped multiple speaker segments; maximum overlap won deterministically.");
  }
  return warnings;
}

async function cleanupExpiredArtifacts(root: string, retentionHours: number, preserveId: string): Promise<void> {
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const artifactDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  await Promise.all(entries.filter((entry) =>
    entry.isDirectory() && artifactDirectory.test(entry.name) && entry.name !== preserveId
  ).map(async (entry) => {
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }));
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
