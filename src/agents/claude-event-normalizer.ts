import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { NativeSdkActivity, formatNativeTool } from "./native-sdk-contract";

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; json?: string };

/** Partial and complete SDK messages update the same existing conversation cards. */
export class ClaudeEventNormalizer {
  private messageId = "";
  private readonly blocks = new Map<number, Block>();
  private readonly toolNames = new Map<string, string>();
  private finalCardId: string | null = null;
  private readonly textCards = new Map<string, string>();

  constructor(
    private readonly activity: NativeSdkActivity,
    private readonly turnId: string,
    private readonly redact: (text: string) => string,
  ) {}

  accept(message: SDKMessage): void {
    // Subagent output must not become the root turn's final answer.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "message_start") {
        this.messageId = event.message.id;
        this.blocks.clear();
      } else if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "text" || block.type === "thinking" || block.type === "tool_use" || block.type === "redacted_thinking") {
          this.blocks.set(event.index, { ...block });
          this.render(event.index);
        }
      } else if (event.type === "content_block_delta") {
        const block = this.blocks.get(event.index);
        if (!block) throw new Error("Claude SDK content delta has no matching block");
        const delta = event.delta;
        if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
        else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
        else if (delta.type === "input_json_delta") block.json = (block.json ?? "") + delta.partial_json;
        this.render(event.index);
      }
      return;
    }
    if (message.type === "assistant") {
      if (message.error) throw new Error(`Claude SDK assistant failed: ${message.error}`);
      if (message.aborted) throw new Error("Claude SDK assistant was aborted");
      this.messageId = message.message.id;
      for (const [index, block] of message.message.content.entries()) {
        if (block.type === "text" || block.type === "thinking" || block.type === "tool_use" || block.type === "redacted_thinking") {
          this.blocks.set(index, { ...block });
          this.render(index);
        }
      }
    } else if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const name = this.toolNames.get(block.tool_use_id) ?? block.tool_use_id;
        this.activity.upsert(`${this.turnId}:result:${block.tool_use_id}`, "agent-tools", this.redact(
          formatNativeTool(`Tool result: ${name} (${block.is_error ? "failed" : "completed"})`, block.content),
        ));
      }
    }
  }

  complete(result: SDKResultMessage): string {
    if (result.subtype !== "success" || result.is_error) {
      const errors = "errors" in result ? result.errors.join("; ") : result.subtype;
      throw new Error(`Claude SDK turn failed: ${errors}`);
    }
    const content = this.redact(result.result);
    if (!content.trim()) throw new Error("Native completed assistant output missing");
    this.abort(this.finalCardId);
    this.activity.upsert(this.finalCardId ?? `${this.turnId}:final`, "assistant", content);
    return content;
  }

  abort(except: string | null = null): void {
    for (const [id, text] of this.textCards) {
      if (id !== except) this.activity.upsert(id, "agent-working", text);
    }
  }

  private render(index: number): void {
    const block = this.blocks.get(index)!;
    const id = `${this.turnId}:${this.messageId}:${index}`;
    if (block.type === "text") {
      this.finalCardId = id;
      const text = this.redact(block.text ?? "");
      this.textCards.set(id, text);
      // Persist an explicitly nonterminal role: a crash cannot turn a stream
      // into a final merely because the rehydrated subprocess is now idle.
      this.activity.upsert(id, "agent-streaming", text);
    } else if (block.type === "thinking") {
      this.activity.upsert(id, "agent-thinking", this.redact(block.thinking ?? ""));
    } else if (block.type === "redacted_thinking") {
      this.activity.upsert(id, "agent-thinking", "Thinking (redacted)");
    } else if (block.type === "tool_use") {
      this.abort();
      this.finalCardId = null;
      if (block.id && block.name) this.toolNames.set(block.id, block.name);
      this.activity.upsert(id, "agent-tools", this.redact(
        formatNativeTool(`Tool call: ${block.name ?? "tool"}`, block.json ?? block.input),
      ));
    }
  }
}
