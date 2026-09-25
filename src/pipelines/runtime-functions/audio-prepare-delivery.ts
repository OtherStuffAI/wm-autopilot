import type { JsonObject } from "../pipeline-store";
import { prepareDeliveryPayload } from "../audio-understanding/package";

export const name = "audio.prepareDelivery";
export const description = "Construct a concise validated Flight Deck result message without publishing it.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return prepareDeliveryPayload(input);
}
