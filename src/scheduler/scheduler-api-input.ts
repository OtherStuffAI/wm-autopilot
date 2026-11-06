import { scheduledSessionContextSchema, type ScheduledSessionContext } from "./session-context";
import type { SchedulerApiDependencies } from "./scheduler-api";

export function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => {
    throw new Error("Invalid JSON payload");
  }) as Promise<Record<string, unknown>>;
}

export function validateCronExpression(expr: string): boolean {
  // Basic validation: 5 or 6 space-separated fields
  const parts = expr.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

export function normaliseModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model && model.toLowerCase() !== "default" ? model : null;
}

export function parsePipelineInput(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, json: "{}" };
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, error: "pipelineInput must be valid JSON" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "pipelineInput must be a JSON object" };
  }
  return { ok: true, json: JSON.stringify(parsed) };
}

// ============================================================
// Route Handlers
// ============================================================

export function parseScheduledContext(value: unknown, action: string, owner: string, bot: string,
  deps: SchedulerApiDependencies): ScheduledSessionContext | null | Response {
  if (value == null) return null;
  if (action !== "session") return Response.json({ error: "Flight Deck context is only valid for session actions" }, { status: 400 });
  const parsed = scheduledSessionContextSchema.safeParse(value);
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  if (parsed.data.ownerNpub !== owner) return Response.json({ error: "Scheduled context owner must match the scheduler owner" }, { status: 400 });
  if (!deps.validateSessionContext) return Response.json({ error: "Scheduled context validation is unavailable" }, { status: 503 });
  try {
    deps.validateSessionContext({ userNpub: owner, botNpub: bot, flightdeckContext: parsed.data });
    return parsed.data;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

