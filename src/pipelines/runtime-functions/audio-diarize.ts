import type { JsonObject } from "../pipeline-store";
import { readAudioEngineConfig } from "../audio-understanding/config";
import { bunAudioCommandRunner } from "../audio-understanding/command-runner";
import { diarizeAudio } from "../audio-understanding/processing";

export const name = "audio.diarize";
export const description = "Run configured local Nemotron 3 diarization and require timestamped anonymous speaker segments.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await diarizeAudio(input, readAudioEngineConfig(), bunAudioCommandRunner);
}
