/** Shared schema for the supported exact-session queue inspection contract. */
export function addSessionQueueContract(paths: Record<string, Record<string, unknown>>): void {
  const revision = { type: "string", pattern: "^[1-9][0-9]*$", example: "1", description: "Decimal edit counter, returned as a string. Send the exact revision previously read." };
  const item = { type: "object", required: ["id", "sessionId", "content", "revision", "state"], properties: {
    id: { type: "string", format: "uuid" }, sessionId: { type: "string" }, content: { type: "string" }, revision,
    state: { type: "string", enum: ["pending", "claimed", "dispatched", "handled"] },
    timestamp: { type: "string", format: "date-time" }, order: { type: "integer" },
    handledAt: { type: "string", format: "date-time", nullable: true }, handledBy: { type: "string", nullable: true },
    handledReason: { type: "string", nullable: true },
  } };
  const queue = { type: "object", required: ["prompts", "handled", "maxSize"], properties: {
    prompts: { type: "array", items: item, description: "Pending and claimed items, in queue order." },
    handled: { type: "array", items: item, description: "Durable handled history; does not count toward pending queue capacity." },
    maxSize: { type: "integer", enum: [21] },
  } };
  const response = { description: "Current queue and handled history", content: { "application/json": { schema: {
    type: "object", required: ["id", "queue"], properties: { id: { type: "string" }, queue, prompt: item },
  } } } };
  const list = paths["/api/sessions/{id}/queue"]!.get as Record<string, unknown>;
  list.description = "Read stable IDs and revisions while the current session is busy. A broker-bound agent can inspect only its exact live session; owner UI visibility is preserved. Ordinary prompts and durable supervised dispatch callbacks are separate inboxes.";
  list.responses = { "200": response, "403": { description: "Different session or denied caller" }, "404": { description: "Session not found" }, "409": { description: "Agent session is inactive" } };
  const acknowledge = paths["/api/sessions/{id}/queue/{itemId}/acknowledge"]!.post as Record<string, unknown>;
  acknowledge.description = "Atomically handle only the previously read revision before dispatch claim. Requires a running session, including a busy active turn. Retains actor/time/reason without sending a prompt. Identical actor/revision/trimmed-reason retry returns the original handled record. Edited, claimed, dispatched or differently acknowledged items conflict. Agent capability permits only its exact self-session route; owner controls retain existing authorization.";
  acknowledge.requestBody = { required: true, content: { "application/json": { schema: {
    type: "object", required: ["revision", "reason"], properties: { revision, reason: { type: "string", minLength: 1 } },
  }, example: { revision: "1", reason: "Completed via callback during this turn" } } } };
  acknowledge.responses = { "200": response, "400": { description: "Missing read revision or nonempty reason" },
    "403": { description: "Different session or denied caller" }, "404": { description: "Item not found in this session" },
    "409": { description: "Edited, claimed/dispatched, differently handled, or inactive session" } };
}
