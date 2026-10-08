import { secretAuthorityFromAuth } from "../secrets/secret-authority";
import { classifierOpenRouterSecrets } from "./classifier-openrouter-credentials";
import { pipelineFunctionHashes } from "./pipeline-function-pins";
import { PublicCallReplay } from "./public-call-store";
import { createHash } from "node:crypto";
import type { RequestAuthContext } from "../auth/request-context";
import type { PipelineApiContext } from "./pipeline-api-routes";
import type { PipelineDefinitionRecord } from "./pipeline-loader";
import { loadPipelineFunctionRegistry } from "./function-loader";
import { builtinPipelineFunctions } from "./functions";
import { resumeDeclarativePipeline } from "./pipeline-runner";
import type { JsonObject } from "./pipeline-store";
import { validateWebhookUrl } from "./result-webhook-http";
import { callError, callFingerprint, callResponse, MAX_PIPELINE_WAIT_MS, PUBLIC_CALL_MODES, waitForPublicRun, type PublicCallMode } from "./public-call-contract";

export async function handlePublicPipelineCall(request: Request, url: URL, authContext: RequestAuthContext,
  ctx: PipelineApiContext, definition: PipelineDefinitionRecord, ownerNpub: string, ownerAlias: string): Promise<Response> {
  const startedAt = performance.now();
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch { return callError("Request body must be a JSON object", "invalid_body", 400); }
  const mode = body.mode ?? (url.searchParams.get("async") === "1" ? "poll" : "wait");
  if (!PUBLIC_CALL_MODES.includes(mode as PublicCallMode)) return callError("mode must be wait, poll, or webhook", "invalid_mode", 400);
  if (body.input !== undefined && (!body.input || typeof body.input !== "object" || Array.isArray(body.input))) {
    return callError("input must be a JSON object", "invalid_input", 400);
  }
  const submittedInput = (body.input ?? {}) as JsonObject;
  const waitSeconds = body.waitSeconds ?? 60;
  if (typeof waitSeconds !== "number" || !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) {
    return callError("waitSeconds must be between 0 and 60", "invalid_wait", 400);
  }
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey && body.idempotencyKey !== undefined && headerKey !== body.idempotencyKey) {
    return callError("Header and body idempotency keys differ", "invalid_idempotency_key", 400);
  }
  const key = headerKey ?? body.idempotencyKey ?? null;
  if (key !== null && (typeof key !== "string" || !key.trim() || key.length > 200)) {
    return callError("idempotencyKey must be a nonempty string of at most 200 characters", "invalid_idempotency_key", 400);
  }
  let webhookUrl: string | null = null;
  if (mode === "webhook") {
    if (!ctx.resultWebhooks) return callError("Result webhook signer is unavailable", "webhook_unavailable", 503);
    const webhook = body.webhook as Record<string, unknown> | null;
    if (!webhook || typeof webhook !== "object" || Array.isArray(webhook) || typeof webhook.url !== "string" || Object.keys(webhook).some(k => k !== "url")) {
      return callError("webhook must contain only an HTTPS url", "invalid_webhook", 400);
    }
    try { webhookUrl = (await validateWebhookUrl(webhook.url)).url.toString(); }
    catch { return callError("Webhook destination must resolve exclusively to public HTTPS addresses on port 443", "unsafe_webhook_url", 400); }
  } else if (body.webhook !== undefined) {
    return callError("webhook is only accepted in webhook mode", "invalid_webhook", 400);
  }
  const fingerprint = callFingerprint({ input: submittedInput, webhookUrl });
  const replay = key ? ctx.store.publicCalls.find(ownerNpub, definition.id, key as string) : null;
  if (replay && replay.fingerprint !== fingerprint) return callError("Idempotency key reused with different input or webhook", "idempotency_conflict", 409);
  if (replay) {
    const existing = ctx.store.getRun(replay.runId);
    if (!existing) throw new Error("Idempotency record refers to a missing pipeline run");
    const waited = mode === "wait"
      ? await waitForPublicRun(ctx.store, existing.id, Math.max(0, waitSeconds * 1000 - (performance.now() - startedAt)), ctx.publicWaitClock)
      : { run: existing, timedOut: false };
    return callResponse(ctx.store, waited.run, { status: waited.run.completedAt ? 200 : 202, timedOut: waited.timedOut, replayed: true });
  }
  const isLearning = /^learning-(plan|question|lesson|assessment|recall)$/.test(definition.spec.name);
  let learningKey: string | null = null;
  if (isLearning) {
    const allowed = new Set(["idempotencyKey", "goal", "concept"]);
    if (Object.keys(submittedInput).some(k => !allowed.has(k))) return callError("Unsupported learning input", "learning_input_denied", 400);
    learningKey = typeof submittedInput.idempotencyKey === "string" ? submittedInput.idempotencyKey.trim() : "";
    if (!learningKey || learningKey.length > 200) return callError("idempotencyKey required", "idempotency_key_required", 400);
  }
  const towerContext = isLearning ? ctx.resolveLearningTowerContext?.({ authContext, ownerNpub }) : null;
  if (isLearning && !towerContext) return callError("An authorized Flight Deck Tower binding is required", "learning_tower_binding_required", 403);
  const input = { ...(definition.spec.input ?? {}), ...submittedInput, ...(towerContext ?? {}) };
  const functions = await loadPipelineFunctionRegistry(ownerAlias, builtinPipelineFunctions);
  // No await between checking a key and atomically persisting the run and delivery.
  const concurrentReplay = key ? ctx.store.publicCalls.find(ownerNpub, definition.id, key as string) : null;
  if (concurrentReplay) {
    if (concurrentReplay.fingerprint !== fingerprint) return callError("Idempotency key reused with different input or webhook", "idempotency_conflict", 409);
    const existing = ctx.store.getRun(concurrentReplay.runId)!;
    const waited = mode === "wait"
      ? await waitForPublicRun(ctx.store, existing.id, Math.max(0, waitSeconds * 1000 - (performance.now() - startedAt)), ctx.publicWaitClock)
      : { run: existing, timedOut: false };
    return callResponse(ctx.store, waited.run, { status: waited.run.completedAt ? 200 : 202, timedOut: waited.timedOut, replayed: true });
  }
  if (learningKey) {
    const inputHash = createHash("sha256").update(JSON.stringify(Object.keys(submittedInput).sort().map(k => [k, submittedInput[k]]))).digest("hex");
    const reservation = ctx.store.reserveLearningRun(ownerNpub, definition.spec.name, learningKey, inputHash);
    if (reservation.state === "conflict") return callError("Idempotency key reused with different input", "idempotency_conflict", 409);
    if (reservation.state === "pending") return callError("Learning run is being created", "idempotency_pending", 409);
    if (reservation.state === "existing") return callResponse(ctx.store, ctx.store.getRun(reservation.runId!)!, { status: 200, replayed: true });
  }
  let run;
  try {
    for (const secret of classifierOpenRouterSecrets({ ownerNpub, sessionApiContext: ctx.sessionApiContext })) ctx.store.evidence.registerSecret(secret);
    run = ctx.store.publicCalls.create({ owner: ownerNpub, definitionId: definition.id, key: key as string | null, fingerprint, webhookUrl }, () => {
      const created = ctx.store.createRun({ definitionId: definition.id, definitionPath: definition.path,
        name: definition.spec.name, ownerNpub, ownerAlias, scope: definition.scope, input });
      ctx.store.composition.pin(created.id, definition, { secretAuthority: secretAuthorityFromAuth(authContext), functionHashes: pipelineFunctionHashes(definition, functions.registry) });
      if (learningKey) ctx.store.bindLearningRun(ownerNpub, definition.spec.name, learningKey, created.id);
      return created;
    });
  } catch (error) {
    if (learningKey) ctx.store.releaseLearningRun(ownerNpub, definition.spec.name, learningKey);
    if (error instanceof PublicCallReplay) {
      if (error.fingerprint !== fingerprint) return callError("Idempotency key reused with different input or webhook", "idempotency_conflict", 409);
      const existing = ctx.store.getRun(error.runId)!;
      const waited = mode === "wait"
        ? await waitForPublicRun(ctx.store, existing.id, Math.max(0, waitSeconds * 1000 - (performance.now() - startedAt)), ctx.publicWaitClock)
        : { run: existing, timedOut: false };
      return callResponse(ctx.store, waited.run, { status: waited.run.completedAt ? 200 : 202, timedOut: waited.timedOut, replayed: true });
    }
    throw error;
  }
  void resumeDeclarativePipeline({ store: ctx.store, sessionApiContext: ctx.sessionApiContext,
    definition, registry: functions.registry, input, ownerNpub, ownerAlias,
    callbackOrigin: ctx.callbackOrigin ?? url.origin }, run.id).catch(error => {
      ctx.store.completeRun(run.id, "error", null, error instanceof Error ? error.message : String(error));
    });
  if (mode !== "wait") return callResponse(ctx.store, run, { status: 202 });
  const waited = await waitForPublicRun(ctx.store, run.id, Math.max(0, Math.min(MAX_PIPELINE_WAIT_MS, waitSeconds * 1000) - (performance.now() - startedAt)), ctx.publicWaitClock);
  return callResponse(ctx.store, waited.run, { status: waited.timedOut ? 202 : 200, timedOut: waited.timedOut });
}
