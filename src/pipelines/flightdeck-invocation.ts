import type { JsonObject } from "./pipeline-store";

export interface FlightDeckPipelineInvocation extends JsonObject {
  workspaceId: string;
  threadId: string;
  frmNpub: string;
  prompt: string;
}

export interface FlightDeckInvocationResolution extends JsonObject {
  workspaceId: string;
  threadId: string;
  channelId: string;
  senderNpub: string;
}

export type FlightDeckInvocationResolver = (
  input: FlightDeckPipelineInvocation,
  ownerNpub?: string | null,
) => Promise<FlightDeckInvocationResolution>;

export type FlightDeckThreadSender = (
  input: {
    workspaceId: string;
    threadId: string;
    frmNpub?: string;
    scopeId?: string;
    channelId?: string;
    message: string;
    pipelineRunId?: string;
    clientRequestId?: string;
  },
) => Promise<JsonObject>;

const resolverKey = Symbol.for("wingmen.pipeline.flightDeckInvocationResolver");
const senderKey = Symbol.for("wingmen.pipeline.flightDeckThreadSender");
type FlightDeckInvocationGlobal = typeof globalThis & {
  [resolverKey]?: FlightDeckInvocationResolver;
  [senderKey]?: FlightDeckThreadSender;
};

export function configureFlightDeckPipelineInvocation(input: {
  resolve: FlightDeckInvocationResolver;
  send: FlightDeckThreadSender;
}): void {
  const target = globalThis as FlightDeckInvocationGlobal;
  target[resolverKey] = input.resolve;
  target[senderKey] = input.send;
}

export function normalizeFlightDeckPipelineInvocation(value: unknown): FlightDeckPipelineInvocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Flight Deck pipeline input must be an object");
  }
  const input = value as Record<string, unknown>;
  const normalized: FlightDeckPipelineInvocation = {
    workspaceId: requiredText(input.workspaceId, "workspaceId"),
    threadId: requiredText(input.threadId, "threadId"),
    frmNpub: requiredText(input.frmNpub, "frmNpub"),
    prompt: requiredSourceText(input.prompt, "prompt"),
  };
  if (!isUuid(normalized.workspaceId)) throw new Error("workspaceId must be a UUID");
  if (!isUuid(normalized.threadId)) throw new Error("threadId must be a UUID");
  if (!normalized.frmNpub.startsWith("npub1")) throw new Error("frmNpub must be an npub");
  return normalized;
}

export async function resolveFlightDeckPipelineInvocation(
  value: unknown,
  ownerNpub?: string | null,
): Promise<{ input: FlightDeckPipelineInvocation; resolution: FlightDeckInvocationResolution }> {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const unexpected = keys.filter((key) => !["workspaceId", "threadId", "frmNpub", "prompt"].includes(key));
  if (unexpected.length > 0) throw new Error(`Unexpected Flight Deck pipeline input: ${unexpected.join(", ")}`);
  const input = normalizeFlightDeckPipelineInvocation(value);
  const resolver = (globalThis as FlightDeckInvocationGlobal)[resolverKey];
  if (!resolver) throw new Error("Flight Deck pipeline invocation is not configured");
  return { input, resolution: await resolver(input, ownerNpub) };
}

export async function returnPipelineMarkdownToFlightDeckThread(input: JsonObject): Promise<JsonObject> {
  const invocation = normalizeFlightDeckPipelineInvocation(input);
  const message = requiredText(input.message, "message");
  const sender = (globalThis as FlightDeckInvocationGlobal)[senderKey];
  if (!sender) throw new Error("Flight Deck pipeline thread delivery is not configured");
  return await sender({ ...invocation, message, pipelineRunId: typeof input.pipelineRunId === "string" ? input.pipelineRunId : undefined });
}

export async function deliverPipelineMessageToFlightDeckRoute(input: JsonObject): Promise<JsonObject> {
  const routeValue = input.route;
  if (!routeValue || typeof routeValue !== "object" || Array.isArray(routeValue)) throw new Error("route is required");
  const route = routeValue as Record<string, unknown>;
  const workspaceId = requiredText(route.workspaceId, "route.workspaceId");
  const threadId = requiredText(route.threadId, "route.threadId");
  const scopeId = requiredText(route.scopeId, "route.scopeId");
  const channelId = requiredText(route.channelId, "route.channelId");
  if (!isUuid(workspaceId)) throw new Error("route.workspaceId must be a UUID");
  if (!isUuid(scopeId)) throw new Error("route.scopeId must be a UUID");
  if (!isUuid(channelId)) throw new Error("route.channelId must be a UUID");
  if (!isUuid(threadId)) throw new Error("route.threadId must be a UUID");
  const sender = (globalThis as FlightDeckInvocationGlobal)[senderKey];
  if (!sender) throw new Error("Flight Deck pipeline thread delivery is not configured");
  return await sender({
    workspaceId,
    scopeId,
    channelId,
    threadId,
    message: requiredText(input.message, "message"),
    pipelineRunId: typeof input.pipelineRunId === "string" ? input.pipelineRunId : undefined,
    clientRequestId: requiredText(input.idempotencyKey, "idempotencyKey"),
  });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredSourceText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
