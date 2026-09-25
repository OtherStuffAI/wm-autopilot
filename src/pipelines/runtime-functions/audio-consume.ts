import type { JsonObject } from "../pipeline-store";
import { invokeOptionalConsumers } from "../audio-understanding/package";

export const name = "audio.consume";
export const description = "Collect optional proofread, summary, graph, and explicitly selected downstream pipeline outcomes.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await invokeOptionalConsumers(input);
}
