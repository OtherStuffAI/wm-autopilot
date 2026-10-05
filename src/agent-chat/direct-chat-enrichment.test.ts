import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectChatEnrichmentStore } from "./direct-chat-enrichment-store.ts";
import { DirectChatEnrichmentCoordinator } from "./direct-chat-enrichment-coordinator.ts";
import { parseEnrichmentConfigs, directChatHandlerMode } from "./direct-chat-enrichment-config.ts";
import { createEnrichmentFunctions } from "./direct-chat-enrichment-functions.ts";
import { createDirectChatEnrichmentService, assertEnrichmentDefinition } from "./direct-chat-enrichment-service.ts";
import { toolRecommendations } from "./context-recommendation-catalogue.ts";
import { searchGraphWithTransport } from "../pipelines/functions.ts";
import { PipelineStore } from "../pipelines/pipeline-store.ts";
import type { JsonObject } from "../pipelines/pipeline-store.ts";

const config = parseEnrichmentConfigs({ w: { pipeline: "agent-direct-context", version: 1 } })!.w!;
const definition = { id: "fixture:enrichment", name: "agent-direct-context", slug: "agent-direct-context", path: "fixture.json", scope: "shared" as const, ownerAlias: null,
  spec: await Bun.file(new URL("../pipelines/default-definitions/agent-direct-context.v1.json", import.meta.url)).json() };
const dbPath = () => join(mkdtempSync(join(tmpdir(), "direct-enrichment-")), "db.sqlite");
const answer = (questions: Record<string, unknown>, value = .99) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { type: "noul", noul: value }])) });

function functions(options: { manifest?: JsonObject[]; memory?: boolean; useful?: number; topic?: string; signal?: AbortSignal } = {}) {
  let graphCalls = 0;
  const funcs = createEnrichmentFunctions({ config: { ...config, memory: options.memory ? { ownerNpub: "owner" } : null },
    manifest: options.manifest ?? [], signal: options.signal ?? new AbortController().signal,
    conversation: async () => ({ newMessages: [{ body: options.topic ?? "Retrieve Twitter" }], recentConversation: [] }),
    graph: async () => { graphCalls++; return { matches: [{ id: "m", excerpt: "Synthetic memory", source: "fixture" }], searchedAt: "2026-10-05T00:00:00Z" }; },
    catalogue: async () => [{ key: "pipeline:bird", name: "Bird", description: "Retrieve Twitter", source: "fixture", kind: "pipeline" }],
    decide: async (_state, questions) => answer(questions, options.useful ?? .99),
  });
  return { funcs, graphCalls: () => graphCalls };
}

async function execute(f: ReturnType<typeof functions>) {
  const conversation = await f.funcs["agentContext.loadConversation"]!({});
  const needs = await f.funcs["agentContext.judgeNeeds"]!(conversation);
  if (needs.memoryNeeded) await f.funcs["agentContext.recallMemory"]!({});
  if (needs.capabilitiesNeeded) await f.funcs["agentContext.findCapabilities"]!({});
  return (await f.funcs["agentContext.returnContext"]!({})).enrichment as JsonObject;
}

describe("Direct chat enrichment", () => {
  test("keeps old modes and validates workspace configuration with bounded defaults", () => {
    expect(directChatHandlerMode(undefined)).toBe("session"); expect(directChatHandlerMode("pipeline_router")).toBe("pipeline_router");
    expect(config).toMatchObject({ threshold: .9, timeoutMs: 12000, maxContextChars: 6000, memory: null });
    expect(() => parseEnrichmentConfigs({ w: { ...config, timeoutMs: 60001 } })).toThrow("timeoutMs");
    expect(() => parseEnrichmentConfigs({ w: { ...config, memory: {} } })).toThrow("owner");
    expect(() => directChatHandlerMode("unknown")).toThrow("handlerMode");
  });

  test("candidate threshold filters marginal recommendations and empty recall is harmless", async () => {
    let graphCalls = 0;
    const funcs = createEnrichmentFunctions({ config: { ...config, memory: { ownerNpub: "fixture-owner" } },
      manifest: [], signal: new AbortController().signal,
      conversation: async () => ({ newMessages: [{ body: "Synthetic new topic" }], recentConversation: [] }),
      graph: async () => { graphCalls++; return { matches: [], searchedAt: "2026-10-05T00:00:00Z" }; },
      catalogue: async () => [{ key: "tool:fixture", name: "Synthetic tool", description: "Marginal recommendation", source: "fixture" }],
      decide: async (_state, questions) => answer(questions, "candidate0" in questions ? .899 : .99),
    });
    await funcs["agentContext.loadConversation"]!({});
    await funcs["agentContext.judgeNeeds"]!({});
    expect((await funcs["agentContext.recallMemory"]!({})).selected).toEqual([]);
    expect((await funcs["agentContext.findCapabilities"]!({})).selected).toEqual([]);
    expect((await funcs["agentContext.returnContext"]!({})).enrichment).toMatchObject({ context: [], status: "ok" });
    expect(graphCalls).toBe(1);
  });

  test("new topic adds Bird context; identical delivered context is deduplicated", async () => {
    const first = await execute(functions());
    expect((first.context as JsonObject[])[0]?.name).toBe("Bird");
    const followup = await execute(functions({ manifest: first.context as JsonObject[] }));
    expect(followup.context).toEqual([]);
    expect(first.diagnostics).toBeDefined(); expect(first.decisions).toBeDefined();
  });

  test("same topic judged sufficient skips memory and capabilities, None never searches memory", async () => {
    const same = functions({ memory: true, useful: .05 });
    expect((await execute(same)).context).toEqual([]); expect(same.graphCalls()).toBe(0);
    const none = functions(); await execute(none); expect(none.graphCalls()).toBe(0);
    const noMatch = functions({ memory: true, useful: .899 });
    expect((await execute(noMatch)).context).toEqual([]);
  });

  test("durably captures modes, fences late results and commits manifest only on acceptance", () => {
    const path = dbPath(); const store = new DirectChatEnrichmentStore(path);
    store.capture("turn", "pipeline_enrichment", config);
    expect(store.capture("turn", "session", null).mode).toBe("pipeline_enrichment");
    const first = store.claim("turn", "session1", 1000)!;
    expect(store.claim("turn", "session1", 1000)).toBeNull();
    expect(store.finish("turn", "wrong-token", { status: "ok", context: [{ key: "late" }] })).toBe(false);
    expect(store.finish("turn", first.token, { status: "ok", context: [{ key: "accepted", source: "fixture" }] })).toBe(true);
    expect(store.manifest("session1")).toEqual([]);
 const restarted = new DirectChatEnrichmentStore(path);
    expect(restarted.claim("turn", "session1", 1000)?.result?.status).toBe("ok");
    restarted.accepted("turn", "other-session"); expect(restarted.manifest("session1")).toEqual([]);
    restarted.accepted("turn", "session1"); expect(restarted.manifest("session1")).toHaveLength(1);
    restarted.accepted("turn", "session1"); expect(restarted.manifest("session1")).toHaveLength(1);
    expect(restarted.claim("turn", "replacement", 1000)?.result).toBeNull();
    expect(restarted.manifest("replacement")).toEqual([]);
    restarted.close();
  });

  test("submission lease prevents duplicate sessions across runtimes", () => {
    const path = dbPath(); const a = new DirectChatEnrichmentStore(path); const b = new DirectChatEnrichmentStore(path);
    expect(a.claimSubmission("route", "a", 10000)).toBe(true);
    expect(b.claimSubmission("route", "b", 10000)).toBe(false);
    expect(a.ownsSubmission("route", "a")).toBe(true);
    b.releaseSubmission("route", "b"); expect(b.claimSubmission("route", "b", 10000)).toBe(false);
    a.releaseSubmission("route", "a"); expect(b.claimSubmission("route", "b", 10000)).toBe(true);
    a.close(); b.close();
  });

  test("broker graph signs exact URL and carries owner, app and group filters and freshness", async () => {
    let signed = ""; let fetched = "";
    const result = await searchGraphWithTransport({ towerBaseUrl: "https://tower.test", workspaceOwnerNpub: "workspace", graphOwnerNpub: "rick",
      sourceAppNpub: "app", groupId: "group", source: "notes", label: "Memory", actorNpub: "rick", visibility: "private",
      entities: [{ name: "question", type: "topic" }] }, {
      sign: async url => { signed = url; return "broker-token"; },
      fetch: async (url, init) => { fetched = String(url); expect(new Headers(init?.headers).get("authorization")).toBe("broker-token");
        return Response.json({ results: [{ id: "synthetic", summary: "Synthetic content", updated_at: "2026-10-05", workspace_owner_npub: "workspace", owner_npub: "rick" }] }); },
    });
    expect(signed).toBe(fetched); const url = new URL(signed); expect(url.pathname).toBe("/api/v4/graph/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ workspace_owner_npub: "workspace", owner_npub: "rick", source_app_npub: "app", group_id: "group" });
    expect((result.matches as any[])[0]).toMatchObject({ updatedAt: "2026-10-05", workspaceOwnerNpub: "workspace", ownerNpub: "rick" });
  });

  test("Jev and graph errors continue Direct with diagnostics and no manifest delivery", async () => {
    for (const message of ["Jev timed out", "Tower graph search failed (HTTP 403)"]) {
      const store = new DirectChatEnrichmentStore(dbPath()); const coordinator = new DirectChatEnrichmentCoordinator(store, async () => { throw new Error(message); });
      store.capture("turn", "pipeline_enrichment", config);
      const result = await coordinator.prepare({ turnId: "turn", sessionId: "s", sourceMessageIds: ["m"], agent: {} as any, input: {} as any }, () => {});
      expect(result).toMatchObject({ status: "error", error: message, context: [] }); expect(store.manifest("s")).toEqual([]); store.close();
    }
  });

  test("tool descriptions come from actual MCP registrations; unavailable hot loading is explicit", async () => {
    const tools = await toolRecommendations(["read_logs"]);
    expect(tools[0]?.description).toContain("logs"); expect(tools[0]?.source).toContain("tools/read-logs.ts");
    expect(tools[0]?.invocation).toContain("no hot-loading");
    await expect(toolRecommendations(["invented_private_tool"])).rejects.toThrow("registrations");
  });

  test("actual pipeline executes five visible actions and cannot dispatch or publish", async () => {
    const store = new PipelineStore(dbPath());
    let runId = ""; const decisions: any[] = [];
    const source = { id: "m", workspace_id: "w", channel_id: "c", thread_id: "t", effective_thread_id: "t", body: "Retrieve Twitter", created_at: "2026-10-05T00:00:00Z", sender_npub: "human" };
    const service = createDirectChatEnrichmentService({ store, callbackOrigin: "http://fixture", getSessionApiContext: () => ({ getStoredInstanceSetting: () => "synthetic-test-credential" }) as any,
      resolveDefinition: async () => definition, listDefinitions: async () => [{ ...definition, name: "Bird", spec: { name: "Bird", description: "Retrieve Twitter", steps: [{ type: "block", block: "flightdeck.threadInvocation", name: "request" }] } }],
      readHistory: async () => ({ messages: [source] }) as any,
      decide: async input => { decisions.push(input); return answer(input.questions); },
    });
    const result = await service({ turnId: "turn", sessionId: "session", sourceMessageIds: ["m"], config, manifest: [], signal: new AbortController().signal,
      onRunStarted: id => { runId = id; }, agent: { agentId: "rick", botNpub: "rick" } as any,
      input: { channel: { id: "c" }, messages: [source], botIdentity: { botNpub: "rick", signNip98: async () => "fixture" },
        subscription: { workspaceId: "w", workspaceOwnerNpub: "owner", managedByNpub: "manager", backendBaseUrl: "https://tower.test" } } as any });
    expect(result.status).toBe("ok"); expect((result.context as JsonObject[])[0]?.name).toBe("Bird");
    expect(store.listSteps(runId)).toHaveLength(5); expect(store.listSteps(runId)[2]?.status).toBe("skipped");
    expect(store.composition.snapshot(runId)?.definition.spec.steps).toEqual(definition.spec.steps);
    expect(decisions[0].questions.memory.type).toBe("noul"); expect(decisions[0].attempts).toBe(1);
    expect(() => assertEnrichmentDefinition({ ...definition, spec: { ...definition.spec, steps: [{ type: "agent", name: "start-rick" }] } })).toThrow("approved context");

  });

  test("wrong workspace in authoritative conversation fails before any Jev or memory request", async () => {
    const store = new PipelineStore(dbPath()); let called = false;
    const source = { id: "m", workspace_id: "wrong", channel_id: "c", thread_id: "t", effective_thread_id: "t", body: "Question", created_at: "2026-10-05T00:00:00Z" };
    const service = createDirectChatEnrichmentService({ store, callbackOrigin: "http://fixture", getSessionApiContext: () => ({}) as any,
      resolveDefinition: async () => definition, readHistory: async () => ({ messages: [source] }) as any,
      decide: async () => { called = true; return {}; } });
    await expect(service({ turnId: "turn", sessionId: "s", sourceMessageIds: ["m"], config, manifest: [], signal: new AbortController().signal,
      onRunStarted: () => {}, agent: { botNpub: "rick" } as any, input: { channel: { id: "c" }, messages: [source], botIdentity: { botNpub: "rick" },
        subscription: { workspaceId: "w", workspaceOwnerNpub: "owner", managedByNpub: "manager" } } as any })).rejects.toThrow("outside the authorized route");
    expect(called).toBe(false);
  });
});
