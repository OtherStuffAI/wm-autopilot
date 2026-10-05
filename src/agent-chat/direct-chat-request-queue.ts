import type { AgentDefinitionRecord } from "./types.ts";
import type { DirectChatRuntimeInput } from "./direct-chat-runtime.ts";

interface CapturedRequest { input: DirectChatRuntimeInput; agent?: AgentDefinitionRecord; contextPrompt?: string; }

/** Ordered request snapshots keep a settings change from altering an active turn. */
export class DirectChatRequestQueue {
  private routes = new Map<string, DirectChatRuntimeInput[]>();
  private profiles = new Map<string, WeakMap<DirectChatRuntimeInput, Omit<CapturedRequest, "input">>>();
  has(route: string) { return this.routes.has(route); }
  head(route: string) { return this.routes.get(route)?.[0]; }
  add(route: string, input: DirectChatRuntimeInput, profile?: Omit<CapturedRequest, "input">) {
    const queue = this.routes.get(route) ?? [];
    if (queue.some(item => item.event.id === input.event.id && item.event.entity_id === input.event.entity_id)) return;
    const profiles = this.profiles.get(route) ?? new WeakMap();
    if (profile && !profiles.has(input)) profiles.set(input, { ...profile, agent: profile.agent ? structuredClone(profile.agent) : undefined });
    this.profiles.set(route, profiles);
    queue.push(input);
    this.routes.set(route, queue);
  }
  take(route: string): CapturedRequest {
    const queue = this.routes.get(route)!;
    const input = queue.shift()!;
    if (!queue.length) this.routes.delete(route);
    return { input, ...this.profiles.get(route)?.get(input) };
  }
}
