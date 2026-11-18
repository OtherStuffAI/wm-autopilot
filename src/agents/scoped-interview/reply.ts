/** Accept a complete JSON document, optionally in one JSON code fence; never extract partial action fragments. */
export function validateInterviewReply(reply: string): string {
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(reply);
  const value = JSON.parse(fence ? fence[1]! : reply);
  if (!value || Array.isArray(value) || ["title","document","response"].some(key => typeof value[key] !== "string" || !value[key].trim())) throw Error("Complete interview title/document/response JSON required");
  return JSON.stringify(value);
}
