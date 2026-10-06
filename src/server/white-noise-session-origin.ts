import type { SessionOrigin } from "../agents/process-manager";

/** Preserve the explicit conversation binding after owner-space authorization. */
export function whiteNoiseSessionOrigin(payload: Record<string, unknown> | null): SessionOrigin | null {
  const origin = payload?.origin;
  if (!origin || typeof origin !== "object" || (origin as { type?: unknown }).type !== "white-noise") return null;
  const id = (origin as { id?: unknown }).id;
  const metadata = payload?.metadata as { agentTransport?: unknown } | undefined;
  if (typeof id !== "string" || !/^(?:[0-9a-f]{2}){1,128}$/.test(id)
    || payload?.agent !== "codex" || metadata?.agentTransport !== "codex-sdk") {
    throw new Error("White Noise origin requires an MLS group id and native Codex transport");
  }
  return { type: "white-noise", id };
}
