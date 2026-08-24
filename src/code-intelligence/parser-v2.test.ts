import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildCorpusDeltas, buildRepositoryDelta } from "./engine";
import type { GraphEdgeInput, GraphNodeInput, RepositoryDefinition } from "./types";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function run(root: string, command: string, ...args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture(files: Record<string, string>): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "parser-v2-")); roots.push(root);
  run(root, "git", "init", "-q"); run(root, "git", "config", "user.email", "fixture@example.com"); run(root, "git", "config", "user.name", "Fixture");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  run(root, "git", "add", "."); run(root, "git", "commit", "-qm", "fixture");
  return { root, head: run(root, "git", "rev-parse", "HEAD") };
}

const definition = (repositoryId: string, corpusId = "wingman-suite"): RepositoryDefinition => ({ corpusId, repositoryId, source: "code-intelligence", scope: { visibility: "agent" } });
const outgoing = (edges: GraphEdgeInput[], from: string, type: string) => edges.filter((edge) => edge.from_external_id === from && edge.relationship_type === type).map((edge) => edge.to_external_id);
const named = (nodes: GraphNodeInput[], name: string) => nodes.find((node) => node.properties.name === name)?.external_id;

describe("parser v2 acceptance", () => {
  test("extracts owned object, class, nested, callback, and function-property callables", async () => {
    const repo = fixture({ "symbols.ts": `
const object = { method() { function nested() {}; nested(); }, property: () => 1 };
class Composer { send() { return object.property(); } }
[1].map(function transform(value) { return value; });
setTimeout(() => object.method(), 1);
` });
    const result = await buildRepositoryDelta({ repository: definition("symbols"), repositoryRoot: repo.root, previousSha: null, currentSha: repo.head, mode: "full_rebuild" });
    const names = result.delta!.nodes.filter((node) => node.labels.includes("Callable")).map((node) => node.properties.name);
    expect(names).toEqual(expect.arrayContaining(["method", "nested", "property", "send", "transform", "setTimeout.callback0"]));
    expect(result.delta!.edges.some((edge) => edge.relationship_type === "OWNED_BY")).toBe(true);
    expect(result.delta!.edges.find((edge) => edge.relationship_type === "CALLS" && edge.properties.callee === "nested")?.from_external_id).toContain("method");
  });

  test("links Flight Deck UI actions through shared calls and Tower persistence", async () => {
    const flightDeck = fixture({
      "composer.html": `<button data-testid="send" @click="composer.sendMessage()">Send</button>\n<button data-testid="reply" @click="composer.sendThreadReply()">Reply</button>\n<button data-testid="deck" @click="composer.sendDeckThread()">Deck</button>`,
      "composer.ts": `import * as shared from './pg-write-adapter';
export const composer = {
  sendMessage() { return shared.sendDeckThread('one'); },
  sendThreadReply() { return shared.sendDeckThread('two'); },
  sendDeckThread() { return shared.sendDeckThread('three'); }
};`,
      "pg-write-adapter.ts": `import { createTowerPgChannelMessage as createMessage } from './tower-client';
export function sendDeckThread(body: string) { return createMessage('workspace-1', 'channel-1', body); }`,
      "tower-client.ts": `const base = '/workspaces';
export function createTowerPgChannelMessage(workspaceId: string, channelId: string, body: string) {
  const path = \`${"${base}"}/${"${encodeURIComponent(workspaceId)}"}/channels/${"${encodeURIComponent(channelId)}"}/messages\`;
  return request(path, { method: 'POST', body });
}`,
    });
    const tower = fixture({
      "routes.ts": `const route = '/workspaces/:workspaceId/channels/:channelId/messages';
const messageSchema = { parse(value: unknown) { return value; } };
export function createMessageHandler(c: unknown) { messageSchema.parse(c); db.select().from(chatMessages); return db.insert(chatMessages); }
app.post(route, createMessageHandler);`,
    });
    const [fd, towerResult] = await buildCorpusDeltas([
      { repository: definition("flight-deck"), repositoryRoot: flightDeck.root, previousSha: null, currentSha: flightDeck.head, mode: "full_rebuild", parserOptions: { apiCallNames: ["request"] } },
      { repository: definition("tower"), repositoryRoot: tower.root, previousSha: null, currentSha: tower.head, mode: "full_rebuild", parserOptions: { routeObjectNames: ["app"] } },
    ]);
    const nodes = [...fd.delta!.nodes, ...towerResult.delta!.nodes];
    const edges = [...fd.delta!.edges, ...towerResult.delta!.edges];
    const actions = nodes.filter((node) => node.node_type === "ui_action");
    expect(actions).toHaveLength(3);
    const actionTargets = actions.flatMap((action) => outgoing(edges, action.external_id, "TRIGGERS"));
    expect(actionTargets.map((id) => nodes.find((node) => node.external_id === id)?.properties.name).sort()).toEqual(["sendDeckThread", "sendMessage", "sendThreadReply"]);
    const shared = nodes.find((node) => node.properties.name === "sendDeckThread" && node.properties.path === "pg-write-adapter.ts")!.external_id;
    expect(actionTargets.every((target) => outgoing(edges, target, "CALLS").includes(shared))).toBe(true);
    const create = named(nodes, "createTowerPgChannelMessage")!;
    expect(outgoing(edges, shared, "CALLS")).toContain(create);
    const consumer = outgoing(edges, create, "CONSUMES_API").find((id) => nodes.find((node) => node.external_id === id)?.node_type === "api_consumer")!;
    const route = outgoing(edges, consumer, "MATCHES_ROUTE")[0]!;
    expect(nodes.find((node) => node.external_id === route)?.properties).toMatchObject({ method: "POST", route: "/workspaces/:workspaceId/channels/:channelId/messages" });
    const handler = outgoing(edges, route, "HANDLED_BY")[0]!;
    const table = outgoing(edges, handler, "WRITES_TO")[0]!;
    expect(nodes.find((node) => node.external_id === table)?.properties.name).toBe("chatMessages");
    expect(outgoing(edges, handler, "READS_FROM")).toContain(table);
    expect(outgoing(edges, handler, "VALIDATED_BY").map((id) => nodes.find((node) => node.external_id === id)?.properties.name)).toContain("messageSchema");
  });

  test("resolves aliased imports and member calls but isolates corpora", async () => {
    const source = fixture({ "api.ts": "export function target() {}", "use.ts": "import { target as alias } from './api'; export const run = () => alias();" });
    const first = await buildRepositoryDelta({ repository: definition("one", "corpus-a"), repositoryRoot: source.root, previousSha: null, currentSha: source.head, mode: "full_rebuild" });
    const second = await buildRepositoryDelta({ repository: definition("two", "corpus-b"), repositoryRoot: source.root, previousSha: null, currentSha: source.head, mode: "full_rebuild" });
    expect(first.delta!.edges.find((edge) => edge.relationship_type === "CALLS")?.to_external_id).toStartWith("corpus-a:one:");
    expect(second.delta!.edges.every((edge) => !edge.to_external_id.startsWith("corpus-a:"))).toBe(true);
  });

  test("does not invent exported symbols for methods called on named imports", async () => {
    const source = fixture({
      "options.ts": "export const OPTIONS = ['one', 'two'];",
      "use.ts": "import { OPTIONS } from './options'; export const enabled = () => OPTIONS.filter(Boolean);",
    });
    const result = await buildRepositoryDelta({ repository: definition("named-import-member"), repositoryRoot: source.root, previousSha: null, currentSha: source.head, mode: "full_rebuild" });
    expect(result.delta!.edges.some((edge) => edge.relationship_type === "CALLS" && edge.to_external_id.includes("OPTIONS.filter"))).toBe(false);
  });

  test("indexes named re-exports so imported calls have a valid graph target", async () => {
    const source = fixture({
      "hydrator.ts": "export function mapThing() {}",
      "support.ts": "export { mapThing } from './hydrator';",
      "use.ts": "import { mapThing } from './support'; export const run = () => mapThing();",
    });
    const result = await buildRepositoryDelta({ repository: definition("re-export"), repositoryRoot: source.root, previousSha: null, currentSha: source.head, mode: "full_rebuild" });
    const alias = "wingman-suite:re-export:symbol:support.ts#mapThing";
    const target = "wingman-suite:re-export:symbol:hydrator.ts#mapThing";
    expect(result.delta!.nodes.some((node) => node.external_id === alias)).toBe(true);
    expect(result.delta!.edges.some((edge) => edge.from_external_id === alias && edge.to_external_id === target && edge.relationship_type === "RESOLVES_TO")).toBe(true);
  });

  test("does not emit graph targets outside the indexed repository", async () => {
    const source = fixture({ "use.ts": "import { external } from '../other/external.js'; export const run = () => external();" });
    const result = await buildRepositoryDelta({ repository: definition("repo-boundary"), repositoryRoot: source.root, previousSha: null, currentSha: source.head, mode: "full_rebuild" });
    expect(result.delta!.edges.some((edge) => edge.to_external_id.includes("symbol:../"))).toBe(false);
  });

  test("resolves call/apply/bind on namespace callables to the callable", async () => {
    const source = fixture({
      "api.ts": "export const service = { run() {} };",
      "use.ts": "import * as api from './api'; export const invoke = () => api.service.run.call(null);",
    });
    const result = await buildRepositoryDelta({ repository: definition("function-prototype"), repositoryRoot: source.root, previousSha: null, currentSha: source.head, mode: "full_rebuild" });
    expect(result.delta!.edges.some((edge) => edge.relationship_type === "CALLS" && edge.to_external_id.endsWith("#service.run"))).toBe(true);
    expect(result.delta!.edges.some((edge) => edge.to_external_id.endsWith("#service.run.call"))).toBe(false);
  });

  test("relinks unchanged files deterministically after route deletion", async () => {
    const source = fixture({ "client.ts": "export const send = () => fetch('/messages', { method: 'POST' });", "route.ts": "app.post('/messages', handler); export function handler() {}" });
    const base = source.head;
    rmSync(join(source.root, "route.ts")); run(source.root, "git", "add", "-A"); run(source.root, "git", "commit", "-qm", "delete route");
    const head = run(source.root, "git", "rev-parse", "HEAD");
    const result = await buildRepositoryDelta({ repository: definition("incremental"), repositoryRoot: source.root, previousSha: base, currentSha: head, mode: "incremental" });
    expect(result.diagnostics.filesParsed).toBe(1);
    expect(result.delta!.delete_edge_external_ids.some((id) => id.includes(":matches:"))).toBe(true);
    expect(result.delta!.edges.some((edge) => edge.relationship_type === "MATCHES_ROUTE")).toBe(false);
    const repeated = await buildRepositoryDelta({ repository: definition("incremental"), repositoryRoot: source.root, previousSha: base, currentSha: head, mode: "incremental" });
    expect(JSON.stringify(result.delta)).toBe(JSON.stringify(repeated.delta));
  });
});
