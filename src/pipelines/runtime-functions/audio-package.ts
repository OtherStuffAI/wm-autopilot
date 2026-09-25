import type { JsonObject } from "../pipeline-store";
import { buildCanonicalPackage } from "../audio-understanding/package";

export const name = "audio.package";
export const description = "Build the stable reusable transcript package with engines and processing metrics.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return buildCanonicalPackage(input);
}
