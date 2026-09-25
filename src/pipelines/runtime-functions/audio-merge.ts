import type { JsonObject } from "../pipeline-store";
import { mergeTranscript } from "../audio-understanding/processing";

export const name = "audio.merge";
export const description = "Assign timestamped words to anonymous diarization segments and form speaker turns.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return mergeTranscript(input);
}
