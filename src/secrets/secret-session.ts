import { object, SecretError, type SecretConsumer } from "./secret-policy";
import type { SecretStore } from "./secret-store";

export interface SecretSessionBinding { ownerNpub: string; botNpub: string; workspaceId?: string | null; sessionId: string }
export function sessionSecretConsumer(binding: SecretSessionBinding, liveWorkspaceId: unknown): SecretConsumer {
  const workspaceId = typeof liveWorkspaceId === "string" && liveWorkspaceId.trim() ? liveWorkspaceId.trim() : "local";
  if ((binding.workspaceId ?? "local") !== workspaceId) throw new SecretError("stale_session_binding", 403);
  return { ownerNpub: binding.ownerNpub, identityNpub: binding.botNpub, workspaceId, context: "session", contextId: binding.botNpub };
}
export function consumeSessionSecret(store: SecretStore, binding: SecretSessionBinding, liveWorkspaceId: unknown, inputValue: unknown) {
  const input = object(inputValue);
  if (Object.keys(input).some(key => ["agentNpub", "pipelineId", "ownerNpub", "workspaceId", "identityNpub"].includes(key))) throw new SecretError("asserted_binding_denied", 403);
  if (typeof input.credentialRef !== "string" || !["sign", "return"].includes(String(input.operation))) throw new SecretError("invalid_secret_request");
  const consumer = sessionSecretConsumer(binding, liveWorkspaceId);
  return store.consume(input.credentialRef, consumer, input.operation as "sign" | "return", input.event);
}
