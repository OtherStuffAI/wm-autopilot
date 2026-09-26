import type { AgentMessage } from "./agent-client";

/** AgentAPI reports a live Codex PTY as running even at its idle composer. */
export function isCodexPtyAtIdleComposer(messages: AgentMessage[]): boolean {
  const screen = messages.at(-1)?.content;
  if (!screen) return false;
  const tail = screen.slice(-2000).replace(/\x1b\[[0-9;]*m/g, "");
  const lines = tail.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const promptIndex = lines.lastIndexOf("› Ask Codex to do anything");
  return promptIndex >= lines.length - 3
    && promptIndex >= 0
    && lines.at(-1)?.includes("? for shortcuts") === true;
}
