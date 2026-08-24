import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRepositoryDelta } from "./engine";
import { routeId } from "./typescript-adapter";
import { TowerCodeIntelligenceClient } from "./tower-client";
import { indexCorpusSequentially, indexRepositoryForPipeline } from "./pipeline";
import type { RepositoryDefinition } from "./types";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const definition = (corpusId = "wingman-suite", repositoryId = "repo-a"): RepositoryDefinition => ({ corpusId, repositoryId, source: "code-intelligence", scope: { visibility: "agent" } });
function command(root: string, executable: string, ...args: string[]) { const result = spawnSync(executable, args, { cwd: root, encoding: "utf8" }); if (result.status) throw new Error(result.stderr); return result.stdout.trim(); }
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "code-intelligence-")); directories.push(root);
  command(root, "git", "init", "-q"); command(root, "git", "config", "user.email", "test@example.com"); command(root, "git", "config", "user.name", "Test");
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
  command(root, "git", "add", "."); command(root, "git", "commit", "-qm", "fixture"); return root;
}
function revise(root: string, files: Record<string, string | null>) { for (const [path, body] of Object.entries(files)) { if (body === null) rmSync(join(root, path)); else { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), body); } } command(root, "git", "add", "-A"); command(root, "git", "commit", "-qm", "revise"); return command(root, "git", "rev-parse", "HEAD"); }

describe("code intelligence engine", () => {
  test("extracts stable imports, exports, components, routes and provenance", async () => {
    const root = repo({ "src/api.ts": "export function hello() { return 1; }\nrouter.get('/api/hello', hello);", "src/view.tsx": "import { hello } from './api';\nexport const Card = () => <section>{hello()}</section>;" });
    const head = command(root, "git", "rev-parse", "HEAD");
    const first = await buildRepositoryDelta({ repository: definition(), repositoryRoot: root, previousSha: null, currentSha: head, mode: "full_rebuild" });
    const second = await buildRepositoryDelta({ repository: definition(), repositoryRoot: root, previousSha: null, currentSha: head, mode: "full_rebuild" });
    expect(first.delta?.nodes.some((node) => node.labels.includes("Exported"))).toBe(true);
    expect(first.delta?.nodes.some((node) => node.node_type === "ui_component")).toBe(true);
    expect(first.delta?.nodes.some((node) => node.node_type === "http_route")).toBe(true);
    expect(JSON.stringify(first.delta)).toBe(JSON.stringify(second.delta));
    expect(JSON.stringify(first.delta)).not.toContain(root);
    expect((first.delta?.nodes[0]?.properties.provenance as any).parser.adapter).toBe("typescript-compiler-api");
  });

  test("reconciles changed, deleted and renamed files with replacement semantics", async () => {
    const root = repo({ "src/a.ts": "export const oldName = 1;\nexport const retainedA = 2;\nexport const retainedB = 3;\n", "src/delete.ts": "export const gone = 1;" });
    const base = command(root, "git", "rev-parse", "HEAD");
    command(root, "git", "mv", "src/a.ts", "src/renamed.ts");
    writeFileSync(join(root, "src/renamed.ts"), "export const newName = 1;\nexport const retainedA = 2;\nexport const retainedB = 3;\n"); rmSync(join(root, "src/delete.ts"));
    command(root, "git", "add", "-A"); command(root, "git", "commit", "-qm", "rename and delete"); const head = command(root, "git", "rev-parse", "HEAD");
    const result = await buildRepositoryDelta({ repository: definition(), repositoryRoot: root, previousSha: base, currentSha: head, mode: "incremental" });
    expect(result.diagnostics.renamed).toEqual([{ from: "src/a.ts", to: "src/renamed.ts" }]);
    expect(result.diagnostics.deleted).toEqual(["src/delete.ts"]);
    expect(result.delta?.delete_node_external_ids.some((id) => id.includes("oldName"))).toBe(true);
    expect(result.delta?.nodes.every((node) => node.property_mode === "replace")).toBe(true);
  });

  test("connects a configured API consumer to a route in another repository and reuses a second corpus", async () => {
    const root = repo({ "client.ts": "export const load = () => fetch('/api/hello');" }); const head = command(root, "git", "rev-parse", "HEAD");
    const target = routeId(definition("wingman-suite", "repo-b"), "GET", "/api/hello");
    const result = await buildRepositoryDelta({ repository: definition(), repositoryRoot: root, previousSha: null, currentSha: head, mode: "full_rebuild", parserOptions: { externalRoutes: { "FETCH /api/hello": target } } });
    expect(result.delta?.edges.find((edge) => edge.relationship_type === "CONSUMES_API")?.to_external_id).toBe(target);
    const other = await buildRepositoryDelta({ repository: definition("customer-corpus", "service"), repositoryRoot: root, previousSha: null, currentSha: head, mode: "full_rebuild" });
    expect(other.delta?.nodes.every((node) => node.external_id.startsWith("customer-corpus:service:"))).toBe(true);
  });
});

describe("Tower client and pipeline", () => {
  test("reads checkpoints, skips unchanged, and sends no secret-bearing input", async () => {
    const root = repo({ "index.ts": "export const value = 1;" }); const head = command(root, "git", "rev-parse", "HEAD");
    const calls: string[] = [];
    const signedFetch = async (url: string) => { calls.push(url); return Response.json({ checkpoints: [{ source: "code-intelligence", corpus_id: "wingman-suite", repository_id: "repo-a", head_sha: head, schema_version: "v1", parser_metadata: {}, index_metadata: {}, updated_at: new Date(0).toISOString() }] }); };
    const client = new TowerCodeIntelligenceClient("https://tower.example", signedFetch);
    const result = await indexRepositoryForPipeline({ towerUrl: "https://tower.example", repository: { ...definition(), root } }, client);
    expect(result.status).toBe("skip"); expect(calls[0]).toContain("repository-checkpoints"); expect(JSON.stringify(result)).not.toMatch(/nsec|capability|bunker/i);
  });

  test.each([[409, "graph_delta_stale_base", "stale_base"], [503, "busy", "retryable_transport_failure"]] as const)("classifies Tower %s responses", async (status, code, expected) => {
    const client = new TowerCodeIntelligenceClient("https://tower.example", async () => Response.json({ code, error: code, current_head_sha: "old" }, { status }));
    expect((await client.submitDelta({} as any)).status).toBe(expected);
  });

  test("classifies an empty Tower delta response without throwing", async () => {
    const client = new TowerCodeIntelligenceClient("https://tower.example", async () => Response.json(null, { status: 413 }));
    const result = await client.submitDelta({} as any);
    expect(result.status).toBe("validation_failure");
    expect(result).toMatchObject({ httpStatus: 413 });
  });

  test("continues after errors so the next run retries failed repositories", async () => {
    const good = repo({ "index.ts": "export const good = 1;" }); const bad = join(tmpdir(), "missing-repository");
    const checkpointFetch = async (url: string) => url.includes("repository-checkpoints") ? Response.json({ checkpoints: [] }) : Response.json({});
    const originalFetch = globalThis.fetch; globalThis.fetch = checkpointFetch as any;
    try {
      const result = await indexCorpusSequentially({ towerUrl: "https://tower.example", mode: "full_rebuild", repositories: [{ ...definition("corpus", "bad"), root: bad }, { ...definition("corpus", "good"), root: good, available: false, unavailableReason: "explicit" }] });
      expect(result.repositories).toHaveLength(2); expect(result.failed).toBe(1); expect(result.skipped).toBe(1);
    } finally { globalThis.fetch = originalFetch; }
  });
});
