import type { JsonObject } from "./pipeline-store";

export function prepareMarkdownMessage(input: JsonObject): JsonObject {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new Error("Markdown message text is required");
  return {
    message: text,
    format: "markdown",
    characters: text.length,
  };
}
