import type { SecretSessionBinding } from "../secrets/secret-session";
import { sessionSecretConsumer } from "../secrets/secret-session";
import { assertSecretUse, object, SecretError, type SecretConsumer } from "../secrets/secret-policy";
import type { SecretStore } from "../secrets/secret-store";

/** Broker-bound configuration only, never arbitrary consumer or workspace assertions. */
export function configureSessionProvider(store: SecretStore, binding: SecretSessionBinding, liveWorkspace: unknown, input: unknown) {
  const body = object(input);
  if (Object.keys(body).some(key => !["sessionId", "operation", "credentialRef", "models", "revision", "enabled"].includes(key))) throw new SecretError("asserted_binding_denied", 403);
  const consumer = sessionSecretConsumer(binding, liveWorkspace);
  if (body.operation === "status") {
    const connection = store.providerConnection(consumer.ownerNpub, consumer.workspaceId);
    if (connection) assertSecretUse(store.get(consumer.ownerNpub, consumer.workspaceId, connection.credentialRef), consumer);
    return { workspaceId: consumer.workspaceId, connection };
  }
  if (body.operation !== "configure" || typeof body.credentialRef !== "string") throw new SecretError("invalid_provider_operation");
  const secret = store.get(consumer.ownerNpub, consumer.workspaceId, body.credentialRef);
  assertSecretUse(secret, consumer);
  const connection = store.saveProviderConnection(consumer.ownerNpub, consumer.workspaceId, {
    credentialRef: body.credentialRef, models: body.models, revision: body.revision, enabled: body.enabled,
  });
  return { workspaceId: consumer.workspaceId, connection };
}

export async function executeSessionProvider(store: SecretStore, binding: SecretSessionBinding, liveWorkspace: unknown, input: unknown,
  test?: (consumer: SecretConsumer) => Promise<unknown>) {
  const body = object(input);
  if (body.operation !== "test") return configureSessionProvider(store, binding, liveWorkspace, body);
  if (Object.keys(body).some(key => !["sessionId", "operation"].includes(key))) throw new SecretError("asserted_binding_denied", 403);
  const consumer = sessionSecretConsumer(binding, liveWorkspace);
  const connection = store.providerConnection(consumer.ownerNpub, consumer.workspaceId);
  if (!connection || !test) throw new SecretError("provider_not_configured", 403);
  assertSecretUse(store.get(consumer.ownerNpub, consumer.workspaceId, connection.credentialRef), consumer);
  return test(consumer);
}
