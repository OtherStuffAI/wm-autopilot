import type { JsonObject } from "../pipeline-store";
import { deliverPipelineMessageToFlightDeckRoute } from "../flightdeck-invocation";

export const name = "audio.deliver";
export const description = "Publish a prepared result to the validated Flight Deck thread through the managed agent identity.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  if (input.requested !== true) return { requested: false, delivered: false, reason: "returnTo_not_supplied" };
  return { ...input, ...await deliverPipelineMessageToFlightDeckRoute(input) };
}
