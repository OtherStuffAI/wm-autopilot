import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject } from "../pipeline-store";
import { inspectAudioCapabilities, validateAudioRequest, type AudioEngineConfig } from "./config";
import { buildCanonicalPackage, correctTranscript, persistTranscriptArtifacts, prepareDeliveryPayload } from "./package";
import { diarizeAudio, mergeTranscript, normaliseAudio, transcribeAudio } from "./processing";
import type { AudioCommandRunner } from "./types";
import { configureAudioUnderstandingAdapters } from "./adapters";

const fixtureDirectory = join(dirname(import.meta.path), "__fixtures__");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  configureAudioUnderstandingAdapters({});
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("audio understanding deterministic core", () => {
  test("runs a fixture-backed end-to-end transcript package", async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, "meeting.wav");
    const modelPath = join(root, "model.bin");
    await Promise.all([writeFile(sourcePath, "fixture audio"), writeFile(modelPath, "model")]);
    const config = fixtureConfig(root, modelPath);
    const runner: AudioCommandRunner = async (command, args) => {
      const outputIndex = args.indexOf("--output-json");
      if (command === "ffmpeg") {
        await writeFile(args.at(-1)!, "normalised audio");
      } else if (command === "stt") {
        await copyFile(join(fixtureDirectory, "stt.json"), args[outputIndex + 1]!);
      } else if (command === "diarize") {
        await copyFile(join(fixtureDirectory, "diarization.json"), args[outputIndex + 1]!);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const request = validateAudioRequest({
      audioRef: sourcePath,
      returnTo: fixtureRoute(),
      options: { glossary: ["Nostr", "Nemotron"], correctTranscript: true, summarise: false },
    }, config);
    const normalised = await normaliseAudio({ source: request.source }, config, runner);
    const stt = await transcribeAudio({ audio: normalised, options: request.options }, config, runner);
    const diarization = await diarizeAudio({ audio: normalised, options: request.options }, config, runner);
    const merged = mergeTranscript({ stt, diarization, options: request.options });
    const corrected = correctTranscript({ transcript: merged, options: request.options });
    const transcriptPackage = buildCanonicalPackage({ request, normalised, stt, diarization, corrected });
    const result = await persistTranscriptArtifacts({ transcriptPackage }, config);
    const delivery = prepareDeliveryPayload({ request, result });

    expect(normalised).toMatchObject({ format: "wav", sampleRateHz: 16000, channels: 1 });
    expect((merged.words as JsonObject[]).map((word) => word.speaker)).toEqual([
      "Speaker 1", "Speaker 1", "Speaker 1", "Speaker 2", "Speaker 2", "Speaker 2",
    ]);
    expect(merged.turns).toHaveLength(2);
    expect(corrected.rawTranscript).toBe("Welcome to Nostre. Nemotron overlaps nicely.");
    expect(corrected.correctedTranscript).toContain("Nostr.");
    expect(corrected.corrections).toEqual([expect.objectContaining({
      oldText: "Nostre.", newText: "Nostr.", source: "caller-glossary", wordIndex: 2,
    })]);
    expect(transcriptPackage).toMatchObject({
      schemaVersion: 1,
      engines: { diarization: { name: "nemotron-3-diarization", identifiesPeople: false } },
      metrics: { wordCount: 6, speakerCount: 2 },
    });
    expect(result.artifacts).toHaveLength(2);
    expect(delivery).toMatchObject({ requested: true, delivered: false, route: fixtureRoute() });
  });

  test("rejects malformed, unsafe, binary, and incomplete routed input", async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, "audio.wav");
    await writeFile(sourcePath, "audio");
    const config = fixtureConfig(root, join(root, "model"));
    expect(() => validateAudioRequest({ audioRef: "relative.wav", returnTo: fixtureRoute() }, config)).toThrow("allowed absolute local path");
    expect(() => validateAudioRequest({ audioRef: "/etc/passwd", returnTo: fixtureRoute() }, config)).toThrow("outside AUDIO_ALLOWED_LOCAL_ROOTS");
    expect(() => validateAudioRequest({ audioRef: `data:audio/wav;base64,${"A".repeat(300)}`, returnTo: fixtureRoute() }, config)).toThrow("binary/base64");
    expect(() => validateAudioRequest({ audioRef: "storage://not-a-uuid", returnTo: fixtureRoute() }, config)).toThrow("storage object id must be a UUID");
    expect(() => validateAudioRequest({ audioRef: sourcePath }, config)).toThrow("returnTo is required");
    expect(() => validateAudioRequest({ audioRef: sourcePath }, config)).toThrow("returnTo is required");
    expect(() => validateAudioRequest({ audioRef: sourcePath, returnTo: { workspaceId: fixtureRoute().workspaceId } }, config)).toThrow("returnTo.scopeId");
  });

  test("reports every missing local capability without a cloud fallback", async () => {
    const root = await temporaryDirectory();
    const capabilities = await inspectAudioCapabilities({
      ffmpegCommand: "missing-ffmpeg",
      sttCommand: "missing-stt",
      sttModel: join(root, "missing-stt-model"),
      diarizationCommand: "missing-diarization",
      diarizationModel: join(root, "missing-diarization-model"),
      artifactRoot: join(root, "artifacts"),
      allowedLocalRoots: [root],
      artifactRetentionHours: 168,
    });
    expect(capabilities.ready).toBe(false);
    expect(capabilities.missing).toEqual([
      "ffmpeg binary (AUDIO_FFMPEG_COMMAND)",
      "timestamped STT binary (AUDIO_STT_COMMAND)",
      "STT model (AUDIO_STT_MODEL)",
      "Nemotron diarization binary (AUDIO_DIARIZATION_COMMAND)",
      "Nemotron diarization model (AUDIO_DIARIZATION_MODEL)",
    ]);
  });

  test("uses fixed argument arrays and surfaces command failure", async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, "audio; touch nope.wav");
    await writeFile(sourcePath, "audio");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: AudioCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 2, stdout: "", stderr: "bad input" };
    };
    await expect(normaliseAudio({ source: { path: sourcePath } }, fixtureConfig(root, join(root, "model")), runner))
      .rejects.toThrow("Audio normalisation failed with exit code 2: bad input");
    expect(calls[0]).toMatchObject({ command: "ffmpeg" });
    expect(calls[0]!.args).toContain(sourcePath);
  });

  test("keeps low-confidence glossary candidates unchanged", () => {
    const corrected = correctTranscript({
      transcript: {
        rawTranscript: "unrelated",
        words: [{ text: "unrelated", start: 0, end: 1, speaker: "Speaker 1", confidence: 1 }],
        turns: [{ speaker: "Speaker 1", start: 0, end: 1, text: "unrelated", wordIndexes: [0] }],
      },
      options: { correctTranscript: true, glossary: ["Nemotron"] },
    });
    expect(corrected.correctedTranscript).toBe("unrelated");
    expect(corrected.corrections).toEqual([]);
  });

  test("marks overlap and gap speaker assignments explicitly", () => {
    const merged = mergeTranscript({
      stt: { rawTranscript: "one two", words: [
        { text: "one", start: 0.4, end: 0.8 },
        { text: "two", start: 2, end: 2.2 },
      ] },
      diarization: { segments: [
        { speaker: "Speaker 1", start: 0, end: 0.7 },
        { speaker: "Speaker 2", start: 0.5, end: 1 },
      ] },
      options: {},
    });
    expect(merged.words).toEqual([
      expect.objectContaining({ speaker: "Speaker 1", attribution: expect.objectContaining({ method: "maximum-overlap", competingSegments: 2 }) }),
      expect.objectContaining({ speaker: "Speaker 2", attribution: expect.objectContaining({ method: "nearest-segment-gap", gapSeconds: 1 }) }),
    ]);
  });

  test("resolves storage references only through the configured broker adapter", async () => {
    const root = await temporaryDirectory();
    const materialised = join(root, "materialised.wav");
    await writeFile(materialised, "audio");
    const calls: JsonObject[] = [];
    configureAudioUnderstandingAdapters({
      resolveStorage: async (input) => { calls.push(input); return { path: materialised }; },
    });
    const runner: AudioCommandRunner = async (_command, args) => {
      await writeFile(args.at(-1)!, "normalised");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const config = fixtureConfig(root, join(root, "model"));
    const output = await normaliseAudio({
      source: { kind: "tower-storage", ref: "storage://11111111-1111-4111-8111-111111111111", objectId: "11111111-1111-4111-8111-111111111111" },
      returnTo: fixtureRoute(),
    }, config, runner);
    expect(output).toMatchObject({ format: "wav" });
    expect(calls).toEqual([expect.objectContaining({ objectId: "11111111-1111-4111-8111-111111111111", route: fixtureRoute() })]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "audio-understanding-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureConfig(root: string, modelPath: string): AudioEngineConfig {
  return {
    ffmpegCommand: "ffmpeg",
    sttCommand: "stt",
    sttModel: modelPath,
    diarizationCommand: "diarize",
    diarizationModel: modelPath,
    artifactRoot: join(root, "artifacts"),
    allowedLocalRoots: [root],
    artifactRetentionHours: 168,
  };
}

function fixtureRoute(): JsonObject {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    scopeId: "22222222-2222-4222-8222-222222222222",
    channelId: "33333333-3333-4333-8333-333333333333",
    threadId: "44444444-4444-4444-8444-444444444444",
  };
}
