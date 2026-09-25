import type { JsonObject } from "../pipeline-store";
import { readAudioEngineConfig } from "../audio-understanding/config";
import { bunAudioCommandRunner } from "../audio-understanding/command-runner";
import { normaliseAudio } from "../audio-understanding/processing";

export const name = "audio.normalise";
export const description = "Normalise authorised local audio to mono 16 kHz PCM without shell interpolation.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await normaliseAudio(input, readAudioEngineConfig(), bunAudioCommandRunner);
}
