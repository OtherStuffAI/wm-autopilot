/**
 * The signed `learning_grant_id` NIP-98 tag names the Space learning delegation a learning request acts under (Tower
 * requires it, matching the `x-learning-grant-id` header, for notification-only agents). The broker signs it only on
 * Tower's allowlisted learning routes and only with the delegation the operator mapped to this bot on that Tower, so an
 * agent session (or model) can never choose a learner.
 */
export const LEARNING_GRANT_TAG = "learning_grant_id";

const LEARNING_ROUTES = new Set([
  "GET /api/v4/learning/curriculum",
  "GET /api/v4/learning/curriculum/traverse",
  "GET /api/v4/learning/mastery",
  "GET /api/v4/learning/recall/due",
  "POST /api/v4/learning/plans",
  "POST /api/v4/learning/lessons",
  "POST /api/v4/learning/assessments",
  "POST /api/v4/learning/recall",
]);

export function splitLearningGrantTags(tags: string[][]): { grant: string[][]; rest: string[][] } {
  return { grant: tags.filter((tag) => tag[0] === LEARNING_GRANT_TAG), rest: tags.filter((tag) => tag[0] !== LEARNING_GRANT_TAG) };
}

/** Why a requested `learning_grant_id` tag may not be signed, or null when it may. */
export function learningGrantTagRefusal(input: {
  grant: string[][];
  url: URL;
  method: string;
  botNpub: string;
  learningGrantFor?: (botNpub: string, towerOrigin: string) => string | null;
}): string | null {
  if (input.grant.length === 0) return null;
  if (input.grant.length !== 1) return "NIP-98 learning_grant_id tag must occur exactly once";
  if (!LEARNING_ROUTES.has(`${input.method.toUpperCase()} ${input.url.pathname}`)) return "NIP-98 learning_grant_id tag is not allowed for this route";
  const mapped = input.learningGrantFor?.(input.botNpub, input.url.origin) ?? null;
  if (!mapped || mapped.toLowerCase() !== String(input.grant[0]![1] ?? "").trim().toLowerCase()) {
    return "NIP-98 learning_grant_id is not the delegation configured for this agent on this Tower";
  }
  return null;
}
