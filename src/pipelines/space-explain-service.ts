import { dirname, join } from "node:path";
import { hashExplainInput, validateExplainOutput, type SpaceExplainRequest } from "./space-explain-contract";
import { readExplainEvidence } from "./space-explain-evidence";
import { createExplainWorker, type ExplainWorker } from "./space-explain-runtime";
import { SpaceExplainStore, type ExplainRun } from "./space-explain-store";
import type { PipelineApiContext } from "./pipeline-api-routes";

export class SpaceExplainService {
  constructor(readonly store: SpaceExplainStore, private worker: (owner: string) => ExplainWorker,
    private timeoutMs = 180_000) {}

  create(owner: string, input: SpaceExplainRequest) {
    // Reservation and binding are one synchronous transaction before any async work.
    const reservation = this.store.reserve(owner, input.requestId, hashExplainInput(input));
    if (!reservation.replayed) void this.execute(reservation.run.id, owner, input);
    return reservation;
  }

  private async execute(id: string, owner: string, input: SpaceExplainRequest): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, this.timeoutMs);
    });
    try {
      const output = await Promise.race([deadline, (async () => {
        const worker = this.worker(owner);
        const evidence = readExplainEvidence(await worker.guide(input, controller.signal), input);
        if (!evidence.supports.length) return validateExplainOutput({ status: "no_supported_match", claims: [],
          inferences: [], citations: [], suggestedConceptIds: [], unknowns: ["No reviewed source support in this guide."] }, evidence, input);
        const raw = await worker.generate(input, evidence, controller.signal);
        return validateExplainOutput(raw, evidence, input);
      })()]);
      this.store.complete(id, output);
    } catch (error) {
      // Never store provider text/errors, which may repeat private question or hints.
      const safeCodes = new Set(["timeout", "invalid_citation", "invalid_concept", "graph_mismatch", "incomplete_evidence",
        "evidence_limit", "invalid_relation", "invalid_support", "inconsistent_support", "provider_unavailable", "evidence_unavailable", "guide_not_cached", "space_explain_unavailable"]);
      const code = error instanceof Error && safeCodes.has(error.message) ? error.message : "invalid_output";
      this.store.fail(id, code);
    } finally { if (timeout) clearTimeout(timeout); controller.abort(); }
  }
}

export function serializeExplainRun(run: ExplainRun) {
  return { contract: "space-explain.v1", id: run.id, requestId: run.request_id, scope: "user", status: run.status,
    createdAt: new Date(run.created_at).toISOString(), error: run.error,
    response: run.output_json ? JSON.parse(run.output_json) : null };
}

const services = new WeakMap<PipelineApiContext["store"], SpaceExplainService>();
export function getExplainService(ctx: PipelineApiContext): SpaceExplainService {
  if (ctx.spaceExplainService) return ctx.spaceExplainService;
  let service = services.get(ctx.store);
  if (!service) {
    service = new SpaceExplainService(new SpaceExplainStore(join(dirname(ctx.store.path), "space-explain.sqlite")),
      owner => createExplainWorker(ctx, owner));
    services.set(ctx.store, service);
  }
  return service;
}
