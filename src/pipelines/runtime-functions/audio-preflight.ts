import type { JsonObject } from "../pipeline-store";
import { inspectAudioCapabilities, readAudioEngineConfig } from "../audio-understanding/config";

export const name = "audio.preflight";
export const description = "Report whether ffmpeg, timestamped STT, Nemotron, and their models are configured locally.";
export const version = 1;

export default async function run(_input: JsonObject): Promise<JsonObject> {
  const result = await inspectAudioCapabilities(readAudioEngineConfig());
  if (result.ready !== true) throw new Error(`Audio capability preflight failed: ${(result.missing as unknown[]).join(", ")}`);
  return result;
}
