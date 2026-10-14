/** Synthetic product-neutral records; never copy operational prompts into fixtures. */
export type TranscriptFormat = "legacy" | "modern" | "mixed";
export function nativeRecord(type: string, payload: Record<string, unknown>, timestamp = "2026-10-14T00:00:01.000Z") {
  return { type, payload, timestamp };
}
export function nativeUser(prompt: string, turnId: string) {
  return nativeRecord("response_item", { type: "message", id: `input-${turnId}`, role: "user", content: [{ type: "input_text", text: prompt }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } });
}
export function completedItem(item: Record<string, unknown>, turnId: string) {
  return nativeRecord("event_msg", { type: "item_completed", thread_id: "native-conversation", turn_id: turnId, item, started_at_ms: 1791936001000, completed_at_ms: 1791936001000 });
}
export function inputRecords(format: TranscriptFormat, prompt: string, turnId: string) {
  if (format === "legacy") return [nativeRecord("event_msg", { type: "user_message", message: prompt })];
  return [
    nativeRecord("event_msg", { type: "task_started", turn_id: turnId, root_turn_id: turnId }),
    nativeRecord("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "Project instructions" }] }),
    nativeRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /example" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["agents_md.instructions"] } }),
    nativeRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>Example workspace</environment_context>" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["environments.environment_context"] } }),
    nativeRecord("turn_context", { turn_id: turnId, root_turn_id: turnId, cwd: "/example" }),
    ...(format === "mixed" ? [nativeRecord("event_msg", { type: "user_message", message: prompt, turn_id: turnId })] : []),
    nativeUser(prompt, turnId),
    completedItem({ type: "UserMessage", id: `user-${turnId}`, content: [{ type: "text", text: prompt, text_elements: [] }] }, turnId),
  ];
}
export function messageRecords(format: TranscriptFormat, text: string, turnId: string, phase = "commentary") {
  if (format === "legacy") return [nativeRecord("event_msg", { type: "agent_message", message: text, phase })];
  return [
    completedItem({ type: "AgentMessage", id: `${phase}-${turnId}`, content: [{ type: "Text", text }], phase }, turnId),
    nativeRecord("response_item", { type: "message", role: "assistant", id: `${phase}-${turnId}`, content: [{ type: "output_text", text }], phase }),
    ...(format === "mixed" ? [nativeRecord("event_msg", { type: "agent_message", message: text, phase, turn_id: turnId })] : []),
  ];
}
export function toolRecords(turnId: string) {
  return [
    nativeRecord("response_item", { type: "custom_tool_call", id: `tool-${turnId}`, call_id: `call-${turnId}`, name: "example_tool", input: "PRIVATE ARGUMENTS", status: "completed" }),
    completedItem({ type: "CommandExecution", id: `command-${turnId}`, command: ["PRIVATE COMMAND"], stdout: "PRIVATE OUTPUT", stderr: "PRIVATE ERROR", status: "completed" }, turnId),
    nativeRecord("response_item", { type: "custom_tool_call_output", call_id: `call-${turnId}`, output: "PRIVATE OUTPUT" }),
    completedItem({ type: "Reasoning", id: `reasoning-${turnId}`, summary_text: ["PRIVATE REASONING"], raw_content: ["PRIVATE REASONING"] }, turnId),
  ];
}
export function completeRecord(reply: string, turnId?: string) {
  return nativeRecord("event_msg", { type: "task_complete", ...(turnId ? { turn_id: turnId } : {}), last_agent_message: reply });
}
