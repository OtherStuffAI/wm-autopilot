import type { JsonObject } from "../pipeline-store";
import { sendPipelineDirectMessage } from "../direct-message-block";

export const name = "flightdeck.sendDirectMessage";
export const description = "Send a Markdown DM from an active Autopilot agent identity to a workspace member.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return await sendPipelineDirectMessage(input);
}
