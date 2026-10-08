import type { FunctionRegistry } from "../pipelines/declarative";
import type { JsonObject, PipelineStore } from "../pipelines/pipeline-store";
import { assertPipelineAncestorsRunning, rootPipelineRunId } from "../pipelines/pipeline-run-authority";
import { boundedText, object, SecretError, validatedNpub, type SecretConsumer } from "./secret-policy";
import type { SecretStore } from "./secret-store";

let store: SecretStore | null = null;
export function configureSecretRuntime(secretStore: SecretStore): void { store = secretStore; }
function runnerOnly(): never { throw new SecretError("trusted_pipeline_runner_required", 403); }
export const secretPipelineFunctions: FunctionRegistry = {
  "secrets.signNostr": runnerOnly,
  "secrets.http": runnerOnly,
};
export function pipelineSecretConsumer(pipelines: PipelineStore, runId: string): SecretConsumer {
  assertPipelineAncestorsRunning(pipelines, runId);
  const run = pipelines.getRun(runId);
  const rootId = rootPipelineRunId(pipelines, runId);
  const root = pipelines.getRun(rootId);
  const snapshot = pipelines.composition.snapshot(runId);
  if (!run || !root || !run.ownerNpub || run.ownerNpub !== root.ownerNpub || run.status !== "running"
    || root.status !== "running" || !snapshot || snapshot.definition.id !== run.definitionId
    || (snapshot.definition.scope === "user" && snapshot.definition.ownerAlias !== run.ownerAlias)) throw new SecretError("stale_pipeline_binding", 403);
  const authority = pipelines.composition.snapshot(rootId)?.context.secretAuthority;
  if (!authority) throw new SecretError("pipeline_secret_authority_missing", 403);
  const workspaceId = boundedText(authority.workspaceId, 128);
  const identityNpub = validatedNpub(authority.principalNpub);
  return { ownerNpub: run.ownerNpub, workspaceId, identityNpub, context: "pipeline", contextId: run.definitionId };
}
export async function executeSecretPipelineFunction(name: string, input: JsonObject, pipelines: PipelineStore, runId: string,
  secretStore: SecretStore | null = store, fetchImpl: typeof fetch = fetch): Promise<JsonObject> {
  if (!secretStore) throw new SecretError("secrets_runtime_unavailable", 503);
  const consumer = pipelineSecretConsumer(pipelines, runId);
  // No asserted run/pipeline/owner/agent bindings are accepted from function arguments.
  if (Object.keys(input).some(key => ["pipelineId", "runId", "ownerNpub", "agentNpub", "workspaceId", "identityNpub"].includes(key))) throw new SecretError("asserted_binding_denied", 403);
  const ref = boundedText(input.credentialRef, 128);
  if (name === "secrets.signNostr") return secretStore.consume(ref, consumer, "sign", input.event);
  if (name !== "secrets.http") throw new SecretError("unknown_secret_function");
  const url = new URL(boundedText(input.url, 2048));
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new SecretError("invalid_secret_consumer_url");
  const method = input.method ?? "POST";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(method))) throw new SecretError("invalid_http_method");
  // Credential-bearing network arguments live only inside this adapter. Never assign a raw value to pipeline state.
  const result = secretStore.consume(ref, consumer, "return", undefined, value => { pipelines.evidence.registerSecret(value); });
  const value = String(result.value);
  try {
    const response = await fetchImpl(url, { method: String(method), redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${value}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(input.body ?? {}) }) });
    // Response bodies/headers can echo credentials; retain only bounded deterministic confirmation.
    await response.body?.cancel();
    return { delivered: response.ok, status: response.status, credentialRef: ref };
  } catch { throw new SecretError("secret_http_failed", 502); }
}
