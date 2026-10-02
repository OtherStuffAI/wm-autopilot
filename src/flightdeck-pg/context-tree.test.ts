import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { FlightDeckPgClient, createBotIdentityFromCapability } from "./client.ts";
import { runFlightDeckPgCli } from "./cli.ts";
import { contextDeleteSchema, artifactTargetSchema } from "./context-contract.ts";
import { FlightDeckPgResponseError } from "./response-error.ts";

export const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const scope = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const root = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const child = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const referenceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = "a".repeat(64);
function requestFrom(input: string | URL | Request, init?: RequestInit) {
  return input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
}
const envelope = { identity: { workspace_id: workspace }, capabilities: { read: true, manage: true } };
const component = (id: string, parent_id: string | null = null) => ({ id, workspace_id: workspace, scope_id: scope, title: id === root ? "API" : "Transport", parent_id, row_version: 1, sort_order: 1 });
function client(fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, signs: Array<Record<string, unknown>> = []) {
  return new FlightDeckPgClient({ towerUrl: "https://tower.test", wingmanUrl: "http://wingman.test", appNpub: "npub1app",
    botIdentity: { botNpub: "npub1bot", botPubkeyHex: "ab".repeat(32), signNostrEvent: async () => { throw new Error("Not used"); }, signNip98: async input => { signs.push(input); return "Nostr test"; } }, fetchImpl: fetchImpl as unknown as typeof fetch });
}

test("context pagination completes all pages with exact signed cursor URL", async () => {
  const signs: Array<Record<string, unknown>> = [];
  const requests: Request[] = [];
  const tree = client(async (input, init) => {
    const request = requestFrom(input, init); requests.push(request);
    return Response.json({ ...envelope, components: [component(requests.length === 1 ? root : child)], next_cursor: requests.length === 1 ? "next/+ cursor" : null });
  }, signs).contextTree;
  const result = await tree.list(workspace, scope, 1);
  expect(result.components).toHaveLength(2);
  expect(result).toMatchObject({ ...envelope, complete: true, pages_read: 2, next_cursor: null });
  expect(requests[1]!.url).toContain("cursor=next%2F%2B+cursor");
  expect(signs.map(s => s.url)).toEqual(requests.map(r => r.url));
});
test("references paginate; cyclic cursors and malformed pages fail clearly", async () => {
  let calls = 0;
  const tree = client(async () => Response.json({ ...envelope, references: [{ id: ++calls }], next_cursor: calls === 1 ? "more" : null })).contextTree;
  expect((await tree.references(workspace, scope, root, 1)).references).toHaveLength(2);
  await expect(client(async () => Response.json({ components: [], next_cursor: "same" })).contextTree.list(workspace, scope)).rejects.toThrow("did not advance");
  await expect(client(async () => Response.json({ components: [] })).contextTree.list(workspace, scope)).rejects.toThrow("pagination envelope");
});
test("path explores selected root ancestry, siblings and children without source reads", async () => {
  const tree = client(async () => Response.json({ ...envelope, components: [component(root), component(child, root), component(referenceId)], next_cursor: null })).contextTree;
  const path = await tree.pathTo(workspace, scope, child);
  expect(path.path.map(row => row.id)).toEqual([root, child]);
  expect((await tree.pathTo(workspace, scope, root)).siblings.map(row => row.id)).toEqual([referenceId]);
  expect((await tree.pathTo(workspace, scope, root)).children.map(row => row.id)).toEqual([child]);
  await expect(tree.read(workspace, scope, scope)).rejects.toMatchObject({ status: 404, envelope: { code: "context_not_found" } });
});
test("missing ancestor and hierarchy cycle surface inconsistent state", async () => {
  await expect(client(async () => Response.json({ ...envelope, components: [component(child, root)], next_cursor: null })).contextTree.pathTo(workspace, scope, child)).rejects.toThrow("ancestor is missing");
  await expect(client(async () => Response.json({ ...envelope, components: [component(child, root), component(root, child)], next_cursor: null })).contextTree.pathTo(workspace, scope, child)).rejects.toThrow("cycle");
});
test("all writes sign exact method/body and preserve row versions/token", async () => {
  const requests: Request[] = []; const signs: Array<Record<string, unknown>> = [];
  const tree = client(async (input, init) => { requests.push(requestFrom(input, init)); return Response.json(envelope); }, signs).contextTree;
  await tree.create(workspace, scope, { title: "API", parent_id: null });
  await tree.update(workspace, scope, root, { expected_row_version: 7, parent_id: child });
  await tree.link(workspace, scope, root, { target_type: "task", target: { record_id: child } });
  await tree.unlink(workspace, scope, root, referenceId, 8);
  await tree.deletePreview(workspace, scope, root);
  await tree.confirmedDelete(workspace, scope, root, { confirmation_token: token, confirmed: true });
  expect(requests.map(r => r.method)).toEqual(["POST", "PATCH", "POST", "DELETE", "GET", "POST"]);
  for (let i = 0; i < requests.length; i++) {
    expect(signs[i]!.url).toBe(requests[i]!.url);
    expect(signs[i]!.method).toBe(requests[i]!.method);
    const text = await requests[i]!.text();
    expect(text ? JSON.parse(text) : undefined).toEqual(signs[i]!.body);
  }
  expect(signs[3]!.body).toEqual({ expected_row_version: 8 });
  expect(signs[5]!.body).toEqual({ confirmation_token: token });
});
test("deletion needs a real token and explicit confirmation before any transport", async () => {
  let calls = 0; const tree = client(async () => { calls++; return Response.json({}); }).contextTree;
  for (const input of [{ confirmed: true }, { confirmation_token: token }, { confirmation_token: token, confirmed: false }, { confirmation_token: "example", confirmed: true }]) {
    expect(contextDeleteSchema.safeParse(input).success).toBe(false);
    await expect(tree.confirmedDelete(workspace, scope, root, input as never)).rejects.toThrow();
  }
  await expect(tree.unlink(workspace, scope, root, referenceId, 0)).rejects.toThrow();
  expect(calls).toBe(0);
});
test.each([403, 404, 409])("preserves Tower error/identity envelope (%s)", async status => {
  const failure = { error: "Denied or changed", code: status === 409 ? "delete_preview_changed" : "permission_denied", identity: envelope.identity };
  const tree = client(async () => Response.json(failure, { status })).contextTree;
  try { await tree.confirmedDelete(workspace, scope, root, { confirmed: true, confirmation_token: token }); throw new Error("expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(FlightDeckPgResponseError); expect(error).toMatchObject({ status, envelope: failure }); }
});
test.each(["doc", "file", "task"] as const)("selected %s reads normal authoritative route and revoked access is neutral", async target_type => {
  const paths: string[] = [];
  const tree = client(async (input, init) => {
    const request = requestFrom(input, init); paths.push(new URL(request.url).pathname);
    if (request.url.includes("/references")) return Response.json({ ...envelope, references: [{ id: referenceId, target_type, target: { record_id: child }, resolution: { status: "available", title: "Visible earlier" } }], next_cursor: null });
    return Response.json({ error: "private title must not leak", code: "permission_denied" }, { status: 403 });
  }).contextTree;
  expect(await tree.reference(workspace, scope, root, referenceId)).toEqual({ identity: envelope.identity, status: "unavailable" });
  expect(paths[1]).toContain(`/${target_type === "doc" ? "docs" : target_type === "file" ? "files" : "tasks"}/${child}`);
});
test("unavailable refs do not open sources; artifacts do not fetch private catalogs", async () => {
  let calls = 0;
  const target = { origin: "https://example.com", project: "Suite", artifact: "Design", page: "index.html", version_policy: "latest" };
  const tree = client(async () => { calls++; return Response.json({ ...envelope, references: [{ id: referenceId, target_type: "artifact", target, resolution: { status: "external" } }], next_cursor: null }); }).contextTree;
  expect(await tree.reference(workspace, scope, root, referenceId)).toMatchObject({ url: "https://example.com/artifacts/Suite/Design/", access_checked: false });
  expect(calls).toBe(1);
  for (const origin of ["javascript:alert(1)", "https://user:pass@example.com", "https://example.com/private", "https://example.com?key=secret"]) expect(artifactTargetSchema.safeParse({ ...target, origin }).success).toBe(false);
});
test("CLI help requires no credentials; context routing/parsing/deletion errors are explicit", async () => {
  expect((await runFlightDeckPgCli(["context-tree", "help"])).stdout).toContain("--confirm");
  const base = ["--key", "1".repeat(64), "--tower-url", "https://tower.test", "--app-npub", "npub1app", "--workspace", workspace, "--scope", scope, "--json"];
  const signs: Request[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => { signs.push(requestFrom(input, init)); return Response.json({ ...envelope, components: [], next_cursor: null }); };
  expect((await runFlightDeckPgCli(["context-tree", "list", ...base], { fetchImpl: fetchImpl as unknown as typeof fetch })).exitCode).toBe(0);
  expect((await runFlightDeckPgCli(["context-tree", "confirmed-delete", root, ...base, "--confirmation-token", token], { fetchImpl: fetchImpl as unknown as typeof fetch })).exitCode).toBe(1);
  expect((await runFlightDeckPgCli(["context-tree", "list", ...base, "--limit", "0"], { fetchImpl: fetchImpl as unknown as typeof fetch })).exitCode).toBe(1);
  expect((await runFlightDeckPgCli(["context-tree", "list", ...base.filter((v, i) => v !== "--scope" && base[i - 1] !== "--scope")], { fetchImpl: fetchImpl as unknown as typeof fetch })).exitCode).toBe(1);
  expect(signs).toHaveLength(1);
});
test("capability identity binds exact URL/method/body hash and rejects signer substitution", async () => {
  const secret = generateSecretKey(); const pubkey = getPublicKey(secret); const botNpub = nip19.npubEncode(pubkey);
  const signed: Record<string, unknown>[] = [];
  const identity = createBotIdentityFromCapability({ wingmanUrl: "http://broker.test", sessionId: "context-unit", capabilityToken: "test-token", botNpub, botPubkeyHex: pubkey,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => { signed.push(JSON.parse(String(init?.body))); return Response.json({ token: "Nostr fixture", signedBy: botNpub }); }) as unknown as typeof fetch });
  const body = { expected_row_version: 3 };
  await identity.signNip98!({ url: "https://tower.test/context/ref", method: "DELETE", body });
  expect(signed[0]).toMatchObject({ url: "https://tower.test/context/ref", method: "DELETE", bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
  const wrong = createBotIdentityFromCapability({ wingmanUrl: "http://broker.test", sessionId: "context-other", capabilityToken: "test-token", botNpub, botPubkeyHex: pubkey, fetchImpl: (async () => Response.json({ token: "Nostr bad", signedBy: "other" })) as unknown as typeof fetch });
  await expect(wrong.signNip98!({ url: "https://tower.test/context", method: "GET" })).rejects.toThrow("identity does not match");
});

test("unavailable target resolution never reveals title or calls source route", async () => {
  let calls = 0;
  const tree = client(async () => { calls++; return Response.json({ ...envelope, references: [{ id: referenceId, target_type: "doc", target: { record_id: child }, resolution: { status: "unavailable" } }], next_cursor: null }); }).contextTree;
  expect(await tree.reference(workspace, scope, root, referenceId)).toEqual({ identity: envelope.identity, status: "unavailable" });
  expect(calls).toBe(1);
});

test("exploration walkthrough chooses one component among roots and reads only its selected source", async () => {
  const requests: string[] = [];
  const tree = client(async (input, init) => {
    const request = requestFrom(input, init); const path = new URL(request.url).pathname; requests.push(path);
    if (path.endsWith("/components")) return Response.json({ ...envelope, components: [component(root), component(child, root), component(referenceId)], next_cursor: null });
    if (path.endsWith("/references")) return Response.json({ ...envelope, references: [
      { id: referenceId, target_type: "task", target: { record_id: child }, resolution: { status: "available", title: "Selected task" } },
      { id: scope, target_type: "doc", target: { record_id: root }, resolution: { status: "available", title: "Unneeded document" } },
    ], next_cursor: null });
    if (path.endsWith(`/tasks/${child}`)) return Response.json({ identity: envelope.identity, task: { id: child, title: "Authoritative selected task", description: "Work on transport" } });
    throw new Error("Workflow must not read unselected documents");
  }).contextTree;
  expect((await tree.list(workspace, scope)).components.filter(row => row.parent_id === null)).toHaveLength(2);
  const chosen = await tree.pathTo(workspace, scope, child);
  expect(chosen.path.map(row => row.title).join(" > ")).toBe("API > Transport");
  expect((await tree.references(workspace, scope, child)).references).toHaveLength(2);
  expect(await tree.reference(workspace, scope, child, referenceId)).toMatchObject({ status: "available", source: { task: { title: "Authoritative selected task" } } });
  expect(requests.filter(path => path.includes("/docs/"))).toHaveLength(0);
  expect(requests.filter(path => path.includes("/tasks/"))).toHaveLength(1);
});

test("CLI returns Tower conflict identity/code/status without retrying deletion", async () => {
  let calls = 0;
  const failure = { error: "Preview changed", code: "delete_preview_changed", identity: envelope.identity };
  const result = await runFlightDeckPgCli(["context-tree", "confirmed-delete", root,
    "--key", "1".repeat(64), "--tower-url", "https://tower.test", "--app-npub", "npub1app",
    "--workspace", workspace, "--scope", scope, "--confirmation-token", token, "--confirm", "--json"], {
    fetchImpl: (async () => { calls++; return Response.json(failure, { status: 409 }); }) as unknown as typeof fetch,
  });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr!)).toEqual({ ok: false, ...failure, status: 409 });
  expect(calls).toBe(1);
});
