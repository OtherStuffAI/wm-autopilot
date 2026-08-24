import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runHeartbeatWake } from "./heartbeat-wake";

describe("heartbeat wake", () => {
  test("uses one bounded sync request per workspace without a native SQLite dependency", async () => {
    const calls: string[] = [];
    const brokerOperations: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input.toString());
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname === "/api/mcp/capabilities/identity") {
        brokerOperations.push("identity.read");
        return Response.json({ identityType: "agent", botNpub: "npub1bot", botPubkeyHex: "ab", ownerNpub: "npub1owner" });
      }
      if (url.pathname === "/api/mcp/capabilities/nip98") {
        brokerOperations.push("nip98.sign");
        return Response.json({ token: "Nostr signed" });
      }
      if (url.pathname === "/api/v4/flightdeck-pg/workspaces") {
        return Response.json({ workspaces: [{ identity: { workspace_id: "workspace-1" }, label: "Example Operator" }] });
      }
      if (url.pathname.endsWith("/workspaces/workspace-1/sync")) {
        expect(url.searchParams.get("since")).toBeTruthy();
        return Response.json({ tasks: [{ id: "task-1" }], messages: [], comments: [] });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    };
    const result = await runHeartbeatWake({
      hours: 12,
      towerUrl: "https://tower.example",
      appNpub: "npub1app",
      context: { wingmanUrl: "http://wingman.test", sessionId: "heartbeat-1", capabilityToken: "capability", fetch: fetch as typeof globalThis.fetch },
      fetchImpl: fetch as typeof globalThis.fetch,
    });
    expect(result.brokerRequests).toBe(3);
    expect(brokerOperations).toEqual(["identity.read", "nip98.sign", "nip98.sign"]);
    expect(calls.filter((path) => path.includes("/sync"))).toHaveLength(1);
    expect(readFileSync(new URL("./heartbeat-wake.ts", import.meta.url), "utf8")).not.toContain("better-sqlite3");
  });

  test("executes the production CLI import chain under Bun without loading better-sqlite3", () => {
    const result = spawnSync("bun", ["clis/heartbeat-wake.ts", "--smoke"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, runtime: "bun", sqlite: "bun-native-or-none" });
    expect(result.stderr).not.toContain("better-sqlite3");
    expect(result.stderr).not.toContain("NODE_MODULE_VERSION");
  });
});
