import { createHash } from "node:crypto";
import { resolvePath, type DeclarativeStep, type DeclarativePipeline } from "./declarative.ts";
import { pipelineAuthorityInput } from "./pipeline-run-authority.ts";
import type { PipelineStore } from "./pipeline-store.ts";

export interface ActivityWebhookSpec { url: string; correlation: Record<string, string>; }
export interface ActivityWebhookDestination { url: string; correlation: Record<string, string>; }
export interface ActivityWebhookEvent {
  version: 1;
  eventId: string;
  sequence: number;
  runId: string;
  stepId: string;
  sessionId: string | null;
  turnId: string;
  correlation: Record<string, string>;
  timestamp: string;
  type: "commentary" | "tools" | "completed" | "failed";
  content: string;
}

export function activityEventId(turnId: string, sourceId: string): string {
  return createHash("sha256").update(JSON.stringify(["wingman.activity.v1", turnId, sourceId])).digest("hex");
}

export function validateActivityWebhookSpec(value: unknown): asserts value is ActivityWebhookSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("activityWebhook must be an object");
  const spec = value as ActivityWebhookSpec;
  if (Object.keys(spec).some(key => !["url", "correlation"].includes(key)) || typeof spec.url !== "string" || spec.url.length > 2048) throw new Error("Invalid activityWebhook configuration");
  const url = new URL(spec.url);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || spec.url !== url.href) {
    throw new Error("activityWebhook URL must be a canonical literal HTTPS:443 URL without credentials or fragment");
  }
  if (!spec.correlation || typeof spec.correlation !== "object" || Array.isArray(spec.correlation) || Object.keys(spec.correlation).length > 16) throw new Error("Invalid activityWebhook correlation selectors");
  for (const [key, path] of Object.entries(spec.correlation)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || typeof path !== "string" || !/^\$\.[A-Za-z0-9_.]+$/.test(path) || path.length > 256) throw new Error("Invalid activityWebhook correlation selector");
  }
}

export function resolveActivityWebhook(store: PipelineStore, runId: string, spec?: ActivityWebhookSpec): ActivityWebhookDestination | null {
  if (spec === undefined) return null;
  validateActivityWebhookSpec(spec);
  const authority = pipelineAuthorityInput(store, runId);
  const correlation: Record<string, string> = {};
  for (const [key, path] of Object.entries(spec.correlation)) {
    const value = resolvePath(authority, path);
    if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new Error(`Missing trusted activity correlation: ${key}`);
    correlation[key] = value;
  }
  return { url: spec.url, correlation };
}

export function validateActivityWebhookSteps(spec: DeclarativePipeline): void {
  function visit(steps: DeclarativeStep[]): void {
    for (const step of steps) {
      const value = (step as { activityWebhook?: unknown }).activityWebhook;
      if (value !== undefined) {
        if (step.type !== "agent" && !(step.type === "code" && step.function === "session.completedTurn")) throw new Error("activityWebhook requires an agent or session.completedTurn step");
        validateActivityWebhookSpec(value);
      }
      if (step.type === "loop" && step.steps) visit(step.steps);
      if (step.type === "parallel") visit([step.step]);
    }
  }
  visit(spec.steps);
}
