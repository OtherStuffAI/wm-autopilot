import type { JsonObject } from "./pipeline-store";

export interface PipelineDirectMessageInput extends JsonObject {
  fromNpub: string;
  toNpub: string;
  message: string;
}

export type PipelineDirectMessageSender = (input: PipelineDirectMessageInput) => Promise<JsonObject>;

const senderKey = Symbol.for("wingmen.pipeline.directMessageSender");
type DirectMessageGlobal = typeof globalThis & { [senderKey]?: PipelineDirectMessageSender };

export function configurePipelineDirectMessageSender(sender: PipelineDirectMessageSender): void {
  (globalThis as DirectMessageGlobal)[senderKey] = sender;
}

export async function sendPipelineDirectMessage(input: JsonObject): Promise<JsonObject> {
  const configuredSender = (globalThis as DirectMessageGlobal)[senderKey] ?? null;
  if (!configuredSender) {
    throw new Error("Flight Deck pipeline direct-message delivery is not configured");
  }
  const fromNpub = requiredText(input.fromNpub, "fromNpub");
  const toNpub = requiredText(input.toNpub, "toNpub");
  const message = requiredText(input.message, "message");
  if (!fromNpub.startsWith("npub1")) throw new Error("fromNpub must be an npub");
  if (!toNpub.startsWith("npub1")) throw new Error("toNpub must be an npub");
  if (fromNpub === toNpub) throw new Error("fromNpub and toNpub must be different");
  return await configuredSender({ fromNpub, toNpub, message });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
