import type { JsonObject } from "../pipeline-store";
import { correctTranscript } from "../audio-understanding/package";

export const name = "audio.correct";
export const description = "Apply only high-confidence glossary corrections while preserving raw text and an audit trail.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return correctTranscript(input);
}
