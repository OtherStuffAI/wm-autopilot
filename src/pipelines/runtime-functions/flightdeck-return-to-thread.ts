import type { JsonObject } from "../pipeline-store";
import { returnPipelineMarkdownToFlightDeckThread } from "../flightdeck-invocation";

export const name = "flightdeck.returnToThread";
export const description = "Return final Markdown to a validated source Flight Deck thread as its managed agent.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await returnPipelineMarkdownToFlightDeckThread(input);
}
