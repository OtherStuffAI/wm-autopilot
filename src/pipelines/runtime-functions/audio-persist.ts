import type { JsonObject } from "../pipeline-store";
import { readAudioEngineConfig } from "../audio-understanding/config";
import { persistTranscriptArtifacts } from "../audio-understanding/package";

export const name = "audio.persist";
export const description = "Persist canonical JSON and readable transcript artifacts and return immutable references.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await persistTranscriptArtifacts(input, readAudioEngineConfig());
}
