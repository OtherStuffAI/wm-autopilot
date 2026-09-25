import type { JsonObject } from "../pipeline-store";
import { readAudioEngineConfig } from "../audio-understanding/config";
import { bunAudioCommandRunner } from "../audio-understanding/command-runner";
import { transcribeAudio } from "../audio-understanding/processing";

export const name = "audio.transcribe";
export const description = "Run configured local STT and require timestamped word JSON.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await transcribeAudio(input, readAudioEngineConfig(), bunAudioCommandRunner);
}
