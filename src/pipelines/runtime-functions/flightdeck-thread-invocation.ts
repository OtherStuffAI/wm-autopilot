import type { JsonObject } from "../pipeline-store";
import { normalizeFlightDeckPipelineInvocation } from "../flightdeck-invocation";

export const name = "flightdeck.threadInvocation";
export const description = "Normalise the four-field Flight Deck thread invocation contract.";
export const version = 1;

export default function run(input: JsonObject): JsonObject {
  return normalizeFlightDeckPipelineInvocation(input);
}
