export const NATIVE_REFERENCE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function parseNativeCodexResult(stdout: string, expectedReference?: string): { nativeReference: string; reply: string } {
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  const started = events.filter((event) => event.type === "thread.started");
  const completed = events.filter((event) => event.type === "turn.completed");
  const nativeReference = started[0]?.thread_id;
  if (started.length !== 1 || typeof nativeReference !== "string" || !NATIVE_REFERENCE.test(nativeReference) || completed.length !== 1 ||
    events.some((event) => event.type === "turn.failed" || event.type === "error") ||
    (expectedReference && nativeReference !== expectedReference)) {
    throw new Error("Missing or inconsistent isolated native completion");
  }
  const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
  if (!messages.length || messages.some((event) => typeof event.item.text !== "string" || !event.item.text.trim())) {
    throw new Error("Isolated native participant reply missing");
  }
  return { nativeReference, reply: messages.map((event) => event.item.text).join("\n") };
}
