#!/usr/bin/env bun

import { cleanupStaleAutosessions, type AutosessionCleanupCandidate } from "../src/sessions/autosession-cleanup";
import { buildAutosessionCleanupRoutes } from "../src/sessions/autosession-cleanup-routes";
import { readCapabilityIdentity } from "../src/mcp/capability-client";
import { buildConfig, parseCommonFlags, requestJson, requestJsonBotCrypto, resolveBaseUrl } from "./lib/auth";

const USAGE = `Stop automatically started live sessions when output-based lastUpdatedAt is more than 63 minutes old.

Usage:
  bun clis/cleanup-autosessions.ts [--url <url>] [--key <nsec|hex> | --bot-crypto] [--json]

Automatically started uses the same explicit provenance as Home > Auto Sessions: metadata.AGENT, programmatic/legacy origins, dispatch metadata, or creator/owner mismatch. The executing session is always excluded. Missing/invalid timestamps and the exact 63-minute boundary are not eligible.`;

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }
  if (args.length > 0) throw new Error(`Unknown argument: ${args[0]}`);

  const currentSessionId = Bun.env.SESSION_ID?.trim();
  if (!currentSessionId) throw new Error("cleanup-autosessions requires SESSION_ID to protect the executing session");
  const baseUrl = resolveBaseUrl(urlInput);
  const ownerNpub = botCrypto
    ? (await readCapabilityIdentity({
        wingmanUrl: baseUrl,
        sessionId: currentSessionId,
        capabilityToken: Bun.env.WINGMAN_CAPABILITY ?? "",
      })).ownerNpub
    : undefined;
  const routes = buildAutosessionCleanupRoutes(ownerNpub);
  const request = async <T>(method: string, path: string): Promise<T> => {
    if (botCrypto) return requestJsonBotCrypto<T>(baseUrl, method, path);
    return requestJson<T>(baseUrl, buildConfig(urlInput, keyInput).secretKey, method, path);
  };

  const payload = await request<{ sessions?: AutosessionCleanupCandidate[] }>("GET", routes.collectionPath);
  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions
    : Array.isArray(payload) ? payload as AutosessionCleanupCandidate[] : [];
  const result = await cleanupStaleAutosessions(sessions, {
    currentSessionId,
    nowMs: Date.now(),
    stopSession: async (sessionId) => {
      await request("DELETE", routes.sessionPath(sessionId));
    },
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Stopped ${result.stopped.length} stale autosession(s).`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
