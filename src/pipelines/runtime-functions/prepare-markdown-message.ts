import type { JsonObject } from "../pipeline-store";
import { prepareMarkdownMessage } from "../markdown-message";

export const name = "text.prepareMarkdownMessage";
export const description = "Validate and package text for Markdown rendering in a message surface.";
export const version = 1;

export default async function run(input: JsonObject): Promise<JsonObject> {
  return prepareMarkdownMessage(input);
}
