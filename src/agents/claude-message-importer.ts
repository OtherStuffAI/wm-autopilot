import type { ReplaceMessageInput } from "../storage/message-store";

interface ClaudeTurnPart {
  content: string;
  createdAt: string;
}

export class ClaudeMessageImporter {
  private readonly messages: ReplaceMessageInput[] = [];
  private readonly toolNamesById = new Map<string, string>();
  private working: ClaudeTurnPart[] = [];
  private assistantTexts: ClaudeTurnPart[] = [];

  addRecord(record: Record<string, unknown>): void {
    if (record.isSidechain === true) {
      return;
    }

    if (isTypedUserMessage(record)) {
      this.flushTurn();
      this.messages.push({
        role: "user",
        content: String((record.message as Record<string, unknown>).content).trim(),
        createdAt: normaliseTimestamp(record.timestamp),
      });
      return;
    }

    if (record.type === "assistant") {
      this.addAssistantRecord(record);
      return;
    }

    if (record.type === "user") {
      this.flushAssistantCommentary();
      for (const part of getMessageContentParts(record)) {
        if (part.type === "tool_result") {
          this.working.push(extractToolResult(part, record.timestamp, this.toolNamesById));
        }
      }
    }
  }

  finish(): ReplaceMessageInput[] {
    this.flushTurn();
    return this.messages;
  }

  private addAssistantRecord(record: Record<string, unknown>): void {
    const parts = getMessageContentParts(record);
    const createdAt = normaliseTimestamp(record.timestamp);
    for (const part of parts) {
      const type = typeof part.type === "string" ? part.type : "";
      if (type === "text") {
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (text) {
          this.assistantTexts.push({ content: text, createdAt });
        }
        continue;
      }
      if (type === "thinking") {
        this.flushAssistantCommentary();
        const thinking = typeof part.thinking === "string" ? part.thinking.trim() : "";
        this.working.push({ content: thinking ? `Thinking:\n${thinking}` : "Thinking...", createdAt });
        continue;
      }
      if (type === "redacted_thinking") {
        this.flushAssistantCommentary();
        this.working.push({ content: "Thinking (redacted)", createdAt });
        continue;
      }
      if (type === "tool_use") {
        this.flushAssistantCommentary();
        const note = summarizeToolUse(part, createdAt, this.toolNamesById);
        if (note) {
          this.working.push(note);
        }
      }
    }
  }

  private flushAssistantCommentary(): void {
    this.working.push(...this.assistantTexts);
    this.assistantTexts = [];
  }

  private flushTurn(): void {
    if (this.assistantTexts.length > 0) {
      const finalText = this.assistantTexts[this.assistantTexts.length - 1]!;
      const earlierText = this.assistantTexts.slice(0, -1);
      const working = [...this.working, ...earlierText];
      if (working.length > 0) {
        this.messages.push({
          role: "agent-working",
          content: joinTurnParts(working),
          createdAt: working[0]!.createdAt,
        });
      }
      this.messages.push({
        role: "agent",
        content: finalText.content,
        createdAt: finalText.createdAt,
      });
    } else if (this.working.length > 0) {
      this.messages.push({
        role: "agent-working",
        content: joinTurnParts(this.working),
        createdAt: this.working[0]!.createdAt,
      });
    }

    this.working = [];
    this.assistantTexts = [];
  }
}

function isTypedUserMessage(record: Record<string, unknown>): boolean {
  if (record.type !== "user" || record.isMeta === true) {
    return false;
  }
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" && content.trim().length > 0;
}

function getMessageContentParts(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content)
    ? content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object" && !Array.isArray(part))
    : [];
}

function summarizeToolUse(
  part: Record<string, unknown>,
  createdAt: string,
  toolNamesById: Map<string, string>,
): ClaudeTurnPart | null {
  const name = typeof part.name === "string" && part.name.trim() ? part.name.trim() : "tool";
  const id = typeof part.id === "string" ? part.id : "";
  if (id) {
    toolNamesById.set(id, name);
  }
  const detail = summarizeToolInput(name, part.input);
  return {
    content: detail ? `Tool call: ${name} ${detail}` : `Tool call: ${name}`,
    createdAt,
  };
}

function extractToolResult(
  toolResult: Record<string, unknown>,
  timestamp: unknown,
  toolNamesById: Map<string, string>,
): ClaudeTurnPart {
  const toolUseId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "";
  const name = toolUseId ? toolNamesById.get(toolUseId) : null;
  const status = toolResult.is_error === true ? "failed" : "completed";
  return {
    content: `Tool result: ${name ?? "tool"} ${status}${summarizeToolResultContent(toolResult.content)}`,
    createdAt: normaliseTimestamp(timestamp),
  };
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const data = input as Record<string, unknown>;
  if (name === "Bash") {
    const command = typeof data.command === "string" ? data.command.trim() : "";
    return command ? `\`${truncateInline(command, 180)}\`` : "";
  }
  if (name === "Agent") {
    const description = typeof data.description === "string" ? data.description.trim() : "";
    return description ? truncateInline(description, 180) : "";
  }
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (description) {
    return truncateInline(description, 180);
  }
  const keys = Object.keys(data).slice(0, 4);
  return keys.length > 0 ? `${keys.join(", ")}` : "";
}

function summarizeToolResultContent(content: unknown): string {
  const text = extractToolResultText(content).replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return `: ${truncateInline(text, 180)}`;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return "";
      }
      const value = item as Record<string, unknown>;
      if (typeof value.text === "string") {
        return value.text;
      }
      if (typeof value.tool_name === "string") {
        return value.tool_name;
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

function joinTurnParts(parts: ClaudeTurnPart[]): string {
  return parts.map((part) => part.content).join("\n\n");
}

function normaliseTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  return new Date().toISOString();
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 14)).trimEnd()}...[truncated]`;
}
