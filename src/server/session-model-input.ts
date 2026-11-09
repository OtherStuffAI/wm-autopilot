/** Preserve omitted/default model selection while rejecting malformed API input. */
export function parseSessionModelInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Invalid model selection");
  return value.trim() || undefined;
}
