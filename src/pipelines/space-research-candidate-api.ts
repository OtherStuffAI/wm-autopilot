import type { JsonObject } from "./pipeline-store";

export const spaceCandidatePath = "/api/v4/learning/research/candidates";

function stableAddition(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if (key === "retrievedAt" || key === "reviewedAt") return undefined;
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item;
  });
}

export async function stageSpaceCandidate(
  candidate: JsonObject,
  post: (path: string, body: JsonObject) => Promise<JsonObject>,
  get?: (path: string) => Promise<JsonObject>,
): Promise<JsonObject> {
  if (candidate.reviewStatus !== "candidate" || candidate.requiresCuratorReview !== true || !candidate.graph || !candidate.baseVersion || !candidate.idempotencyKey) {
    throw new Error("Validated review-gated candidate required");
  }
  const id = String(candidate.idempotencyKey).replace(/[^a-z0-9-]/g, "-").slice(0, 120);
  if (get) {
    let prior: JsonObject | null = null;
    try { prior = await get(`${spaceCandidatePath}/${id}`); }
    catch (error) { if (!(error instanceof Error) || !/^404\b/.test(error.message)) throw error; }
    if (prior) {
      const record = prior.candidate as JsonObject | undefined;
      if (!record || record.base_version !== candidate.baseVersion || stableAddition(record.addition) !== stableAddition(candidate.graph)) {
        throw new Error("Existing candidate differs for the subject/source/version key");
      }
      if (record.status !== "staged") throw new Error(`Existing candidate has already advanced to ${String(record.status)}`);
      return { candidateId: id, reviewStatus: "staged", idempotent: true, issues: [] };
    }
  }
  const result = await post(spaceCandidatePath, { id, baseVersion: candidate.baseVersion, addition: candidate.graph });
  if (Array.isArray(result.issues) && result.issues.length) throw new Error(`Tower rejected candidate issues: ${result.issues.join(", ")}`);
  if (!result.candidate || typeof result.candidate !== "object" || (result.candidate as JsonObject).status !== "staged") throw new Error("Tower did not confirm staged candidate");
  return { candidateId: id, reviewStatus: "staged", idempotent: result.idempotent === true, issues: result.issues ?? [] };
}
