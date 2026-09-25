import type { JsonObject } from "../pipeline-store";
import { readAudioEngineConfig, validateAudioRequest } from "../audio-understanding/config";

export const name = "audio.validateRequest";
export const description = "Validate an audio reference, options, and optional Flight Deck return route.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return validateAudioRequest(input, readAudioEngineConfig());
}
