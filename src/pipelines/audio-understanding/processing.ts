import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../pipeline-store";
import type { AudioEngineConfig } from "./config";
import { runChecked } from "./command-runner";
import type { AudioCommandRunner, AudioWord, DiarizationSegment, TranscriptTurn } from "./types";
import { getAudioUnderstandingAdapters } from "./adapters";

export async function normaliseAudio(
  input: JsonObject,
  config: AudioEngineConfig,
  runner: AudioCommandRunner,
): Promise<JsonObject> {
  const source = objectValue(input.source);
  if (source.kind === "tower-storage") {
    const resolveStorage = getAudioUnderstandingAdapters().resolveStorage;
    if (!resolveStorage) throw new Error("Tower storage audio resolution is unavailable: configure the brokered audio storage adapter");
    const resolved = await resolveStorage({
      objectId: requiredText(source.objectId, "source.objectId"),
      audioRef: requiredText(source.ref, "source.ref"),
      route: objectValue(input.returnTo),
    });
    return await normaliseAudio({ ...input, source: { kind: "local", path: resolved.path, storageMetadata: resolved.metadata ?? {} } }, config, runner);
  }
  const sourcePath = requiredText(source.path, "source.path");
  const workingDirectory = await mkdtemp(join(tmpdir(), "wingman-audio-"));
  const outputPath = join(workingDirectory, "normalised.wav");
  const startedAt = performance.now();
  await runChecked(runner, config.ffmpegCommand, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath,
  ], "Audio normalisation");
  const info = await stat(outputPath);
  return {
    path: outputPath,
    format: "wav",
    sampleRateHz: 16000,
    channels: 1,
    sizeBytes: info.size,
    processingSeconds: elapsedSeconds(startedAt),
  };
}

export async function transcribeAudio(
  input: JsonObject,
  config: AudioEngineConfig,
  runner: AudioCommandRunner,
): Promise<JsonObject> {
  const audio = objectValue(input.audio);
  const options = objectValue(input.options);
  const audioPath = requiredText(audio.path, "audio.path");
  const outputPath = `${audioPath}.stt.json`;
  const args = [
    "--model", config.sttModel,
    "--audio", audioPath,
    "--output-json", outputPath,
    "--word-timestamps",
  ];
  if (options.language && options.language !== "auto") args.push("--language", String(options.language));
  const glossary = stringArray(options.glossary);
  if (glossary.length > 0) args.push("--initial-prompt", glossary.join(", "));
  const startedAt = performance.now();
  const result = await runChecked(runner, config.sttCommand, args, "Timestamped STT");
  const payload = await readJsonOutput(outputPath, result.stdout, "STT");
  const words = normaliseWords(payload.words);
  if (words.length === 0) throw new Error("STT output must contain at least one timestamped word");
  return {
    words,
    rawTranscript: typeof payload.text === "string" ? payload.text : joinWords(words),
    language: typeof payload.language === "string" ? payload.language : options.language ?? "auto",
    engine: { name: "local-timestamped-stt", model: config.sttModel },
    processingSeconds: elapsedSeconds(startedAt),
  };
}

export async function diarizeAudio(
  input: JsonObject,
  config: AudioEngineConfig,
  runner: AudioCommandRunner,
): Promise<JsonObject> {
  const audio = objectValue(input.audio);
  const options = objectValue(input.options);
  const audioPath = requiredText(audio.path, "audio.path");
  const outputPath = `${audioPath}.diarization.json`;
  const args = ["--model", config.diarizationModel, "--audio", audioPath, "--output-json", outputPath];
  if (options.speakerCount !== "auto" && options.speakerCount !== undefined) {
    args.push("--speakers", String(options.speakerCount));
  }
  const startedAt = performance.now();
  const result = await runChecked(runner, config.diarizationCommand, args, "Nemotron diarization");
  const payload = await readJsonOutput(outputPath, result.stdout, "Diarization");
  const segments = normaliseSegments(payload.segments);
  if (segments.length === 0) throw new Error("Diarization output must contain at least one segment");
  return {
    segments,
    speakers: [...new Set(segments.map((segment) => segment.speaker))].map((label) => ({ label })),
    engine: { name: "nemotron-3-diarization", model: config.diarizationModel, identifiesPeople: false },
    processingSeconds: elapsedSeconds(startedAt),
  };
}

export function mergeTranscript(input: JsonObject): JsonObject {
  const stt = objectValue(input.stt);
  const diarization = objectValue(input.diarization);
  const options = objectValue(input.options);
  const mapping = objectValue(options.speakerMapping);
  const segments = normaliseSegments(diarization.segments);
  const words = normaliseWords(stt.words).map((word) => {
    const assignment = assignSpeaker(word, segments);
    const speaker = typeof mapping[assignment.speaker] === "string" ? String(mapping[assignment.speaker]) : assignment.speaker;
    return { ...word, speaker, attribution: assignment };
  });
  const turns = buildTurns(words);
  const speakers = [...new Set(words.map((word) => word.speaker))].map((label) => ({
    label,
    mapped: Object.values(mapping).includes(label),
  }));
  return { words, turns, speakers, rawTranscript: String(stt.rawTranscript ?? joinWords(words)) };
}

function assignSpeaker(word: AudioWord, segments: DiarizationSegment[]): JsonObject & { speaker: string } {
  let best: DiarizationSegment | null = null;
  let bestOverlap = 0;
  let overlapCount = 0;
  for (const segment of segments) {
    const overlap = Math.max(0, Math.min(word.end, segment.end) - Math.max(word.start, segment.start));
    if (overlap > 0) overlapCount += 1;
    if (overlap > bestOverlap + Number.EPSILON * 8) {
      best = segment;
      bestOverlap = overlap;
    }
  }
  if (best) return { speaker: best.speaker, method: "maximum-overlap", overlapSeconds: bestOverlap, competingSegments: overlapCount };
  const nearest = segments.reduce<{ segment: DiarizationSegment; distance: number } | null>((current, segment) => {
    const distance = word.end < segment.start ? segment.start - word.end : word.start > segment.end ? word.start - segment.end : 0;
    return !current || distance < current.distance ? { segment, distance } : current;
  }, null);
  return nearest
    ? { speaker: nearest.segment.speaker, method: "nearest-segment-gap", gapSeconds: nearest.distance }
    : { speaker: "Unknown Speaker", method: "no-diarization-segments" };
}

function buildTurns(words: AudioWord[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  words.forEach((word, index) => {
    const current = turns.at(-1);
    if (current && current.speaker === word.speaker && word.start - current.end <= 1.25) {
      current.end = word.end;
      current.text = `${current.text}${needsLeadingSpace(word.text) ? " " : ""}${word.text}`;
      current.wordIndexes.push(index);
      return;
    }
    turns.push({ speaker: word.speaker, start: word.start, end: word.end, text: word.text, wordIndexes: [index] });
  });
  return turns;
}

function normaliseWords(value: unknown): AudioWord[] {
  if (!Array.isArray(value)) throw new Error("STT words must be an array");
  return value.map((entry, index) => {
    const word = objectValue(entry);
    const text = requiredText(word.text ?? word.word, `words[${index}].text`);
    const start = timestamp(word.start, `words[${index}].start`);
    const end = timestamp(word.end, `words[${index}].end`);
    if (end < start) throw new Error(`words[${index}].end must not precede start`);
    return { text, start, end, confidence: confidence(word.confidence ?? word.probability), speaker: String(word.speaker ?? "") };
  });
}

function normaliseSegments(value: unknown): DiarizationSegment[] {
  if (!Array.isArray(value)) throw new Error("Diarization segments must be an array");
  return value.map((entry, index) => {
    const segment = objectValue(entry);
    const rawSpeaker = segment.speaker ?? segment.speaker_id ?? segment.label;
    const label = typeof rawSpeaker === "number" ? `Speaker ${rawSpeaker + 1}` : requiredText(rawSpeaker, `segments[${index}].speaker`);
    const start = timestamp(segment.start, `segments[${index}].start`);
    const end = timestamp(segment.end, `segments[${index}].end`);
    if (end < start) throw new Error(`segments[${index}].end must not precede start`);
    return { speaker: label, start, end, confidence: confidence(segment.confidence) };
  }).sort((left, right) => left.start - right.start || left.end - right.end);
}

async function readJsonOutput(path: string, stdout: string, label: string): Promise<JsonObject> {
  const source = await readFile(path, "utf8").catch(() => stdout);
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as JsonObject;
  } catch (error) {
    throw new Error(`${label} did not produce a valid JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function joinWords(words: AudioWord[]): string {
  return words.reduce((text, word) => `${text}${text && needsLeadingSpace(word.text) ? " " : ""}${word.text}`, "");
}

function needsLeadingSpace(text: string): boolean {
  return !/^[,.;:!?)]/.test(text);
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

function timestamp(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function confidence(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function elapsedSeconds(startedAt: number): number {
  return Number(((performance.now() - startedAt) / 1000).toFixed(3));
}
