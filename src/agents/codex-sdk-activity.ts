import type { ThreadEvent } from "@openai/codex-sdk";
import { NativeSdkActivity, formatNativeTool } from "./native-sdk-contract";

/** Both native SDKs emit the same thinking/tools roles and Markdown contract. */
export function recordCodexSdkActivity(event: ThreadEvent, activity: NativeSdkActivity, turnId: string): void {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return;
  const item = event.item;
  const id = `${turnId}:${item.id}`;
  if (item.type === "reasoning") activity.upsert(id, "agent-thinking", item.text);
  else if (item.type === "command_execution") {
    activity.upsert(id, "agent-tools", formatNativeTool(`Tool call: command (${item.status})`, item.command)
      + "\n\n" + formatNativeTool("Tool result", item.aggregated_output));
  } else if (item.type === "mcp_tool_call") {
    activity.upsert(id, "agent-tools", formatNativeTool(`Tool call: ${item.server}.${item.tool} (${item.status})`, item.arguments)
      + (item.result ? "\n\n" + formatNativeTool("Tool result", item.result) : "")
      + (item.error ? "\n\n" + formatNativeTool("Tool error", item.error) : ""));
  } else if (item.type === "file_change" || item.type === "web_search") {
    activity.upsert(id, "agent-tools", formatNativeTool(`Tool call: ${item.type}`, item));
  }
}
