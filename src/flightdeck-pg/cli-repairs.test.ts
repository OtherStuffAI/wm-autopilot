import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nip19, verifyEvent } from "nostr-tools";
import { runFlightDeckPgCli as runCli } from "./cli";
import { parseFlightDeckOptions } from "./cli-options";
import { FlightDeckPgClient, createBotIdentityFromSecret } from "./client";

const originalFetch = globalThis.fetch;
async function runFlightDeckPgCli(argv: string[], io: Parameters<typeof runCli>[1] = {}) {
  if (io.fetchImpl) globalThis.fetch = io.fetchImpl;
  return runCli(argv, io);
}
const envNames = ["SESSION_ID", "WINGMAN_CAPABILITY", "WINGMAN_URL", "WINGMAN_BROKER_URL", "BOT_NPUB", "BOT_PUBKEY_HEX"];
const original = Object.fromEntries(envNames.map(name => [name, Bun.env[name]]));
beforeEach(() => { for (const name of envNames) delete Bun.env[name]; });
afterEach(() => { globalThis.fetch = originalFetch; for (const name of envNames) { if (original[name] === undefined) delete Bun.env[name]; else Bun.env[name] = original[name]; } });
const auth = ["--key", "1".repeat(64), "--tower-url", "https://tower.test", "--app-npub", "app", "--workspace", "w", "--json"];
const npub = nip19.npubEncode("2".repeat(64));
const mentions = [{ type: "agent", npub, label: "Target" }];
const tag = `@[Target](mention:agent:${npub})`;
const json = (value: unknown) => Response.json(value);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function client(fetchImpl: typeof fetch) {
  globalThis.fetch = fetchImpl;
  return new FlightDeckPgClient({ towerUrl: "https://tower.test", wingmanUrl: "", appNpub: "app", botIdentity: createBotIdentityFromSecret(new Uint8Array(32).fill(1)), fetchImpl });
}

test("boolean switches preserve following command and positional words", () => {
  expect(parseFlightDeckOptions(["--bot-crypto", "threads", "list", "--json"]).positionals).toEqual(["threads", "list"]);
  expect(parseFlightDeckOptions(["--json", "doc", "show", "d", "--body"]).flags.get("--body")).toBe(true);
  expect(parseFlightDeckOptions(["--body", "doc", "show", "d"]).flags.get("--body")).toBe(true);
  expect(parseFlightDeckOptions(["doc", "reply", "--body", "show"]).flags.get("--body")).toBe("show");
  expect(parseFlightDeckOptions(["doc", "reply", "--body", "doc"]).flags.get("--body")).toBe("doc");
  expect(parseFlightDeckOptions(["doc", "reply", "--body", "show", "--comment", "doc"]).positionals).toEqual(["doc", "reply"]);
});

for (const argv of [
  ["tasks", "list", "--typo", "x"], ["tasks", "list", "extra"], ["task", "show", "id", "extra"],
  ["task", "show", "id", "--mentions-json", "[]"], ["tasks", "list", "--owner", "other"],
  ["tasks", "list", "--limit"], ["tasks", "list", "--json", "true"], ["tasks", "list", "--json", "--json"],
]) test(`invalid command fails before network: ${argv.join(" ")}`, async () => {
  let requests = 0;
  const result = await runFlightDeckPgCli(argv, { fetchImpl: (async () => { requests++; return json({}); }) as typeof fetch });
  expect(result.exitCode).toBe(1);
  expect(requests).toBe(0);
});

test("context tree maintains hyphen and underscore operation aliases", () => {
  for (const operation of ["delete-preview", "delete_preview", "confirmed-delete", "confirmed_delete"]) {
    const args = ["context-tree", operation, "id"];
    expect(parseFlightDeckOptions(args).positionals).toEqual(args);
  }
});

for (const [area, action, id] of [["chat", "reply", ""], ["task", "comment", "t"], ["doc", "reply", "d"]]) {
  test(`ordinary ${area} ${action} preserves dual mentions in signed payload`, async () => {
    let body: Record<string, any> = {};
    const result = await runFlightDeckPgCli([area!, action!, ...(id ? [id] : []), "--channel", "c", "--thread", "th", "--body", "hello", "--mentions-json", JSON.stringify(mentions), ...auth].filter((value, index, values) => {
      // Only chat consumes --channel; task consumes --thread; doc uses neither.
      if (area !== "chat" && (value === "--channel" || values[index - 1] === "--channel")) return false;
      if (area === "doc" && (value === "--thread" || values[index - 1] === "--thread")) return false;
      return true;
    }), { fetchImpl: (async (url, init) => {
      const request = new Request(url, init); body = await request.json();
      const signature = JSON.parse(Buffer.from(request.headers.get("authorization")!.slice(6), "base64").toString());
      expect(verifyEvent(signature)).toBe(true);
      expect(signature.tags).toContainEqual(["payload", hash(JSON.stringify(body))]);
      return json({ ok: true });
    }) as typeof fetch });
    expect(result.stderr ?? "").toBe("");
    expect(result.exitCode).toBe(0);
    expect(body.body).toBe(`hello\n\n${tag}`);
    expect(body.mentions).toEqual(mentions);
    if (area === "chat") expect(verifyEvent(body.message_signature.nostr_event)).toBe(true);
  });
}

test("visible agent tags without routing entries and invalid mentions fail before network", async () => {
  for (const options of [["--body", tag], ["--body", "hi", "--mentions-json", "{}"], ["--body", "hi", "--mentions-json", '[{"type":"agent","npub":"invalid","label":"X"}]']]) {
    let called = false;
    const result = await runFlightDeckPgCli(["chat", "reply", ...options, ...auth], { fetchImpl: (async () => { called = true; return json({}); }) as typeof fetch });
    expect(result.exitCode).toBe(1); expect(called).toBe(false);
  }
});

for (const area of ["task", "doc"]) test(`${area} comments forward exact cursor and mark partial pages`, async () => {
  let target = "";
  const result = await runFlightDeckPgCli([area, "comments", "id", "--limit", "1", "--cursor", "opaque+/= .742883+00", ...auth], {
    fetchImpl: (async (input) => { target = String(input); return json({ comments: [{ id: "1" }], next_cursor: "next", has_more: true }); }) as typeof fetch,
  });
  expect(new URL(target).searchParams.get("cursor")).toBe("opaque+/= .742883+00");
  expect(JSON.parse(result.stdout!)).toMatchObject({ partial: true, complete: false, has_more: true });
});

test("all comment pages preserve order, and repeated rows/cursors fail", async () => {
  const seen: Array<string | null> = [];
  const c = client((async input => {
    const cursor = new URL(String(input)).searchParams.get("cursor"); seen.push(cursor);
    return json(cursor ? { comments: [{ id: "2" }], next_cursor: null } : { comments: [{ id: "1" }], next_cursor: "next" });
  }) as typeof fetch);
  expect(await c.listTaskComments("w", "t", 1, null, true)).toMatchObject({ comments: [{ id: "1" }, { id: "2" }], complete: true, partial: false });
  expect(seen).toEqual([null, "next"]);
  const broken = client((async () => json({ comments: [{ id: "1" }], next_cursor: "same" })) as typeof fetch);
  await expect(broken.listTaskComments("w", "t", 1, null, true)).rejects.toThrow("repeated");
});

test("document export retrieves every comment page before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doc-export-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const out = join(dir, "document.md");
  const c = client((async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/body")) return json({ doc: { id, title: "Doc", row_version: 1 }, body: { encoding: "base64", base64_data: Buffer.from("Body").toString("base64") } });
    return json(url.searchParams.has("cursor") ? { comments: [{ id: "2", body: "Later comment" }], next_cursor: null } : { comments: [{ id: "1", body: "First comment" }], next_cursor: "next" });
  }) as typeof fetch);
  try {
    expect((await c.downloadDoc("w", id, out, { downloadStorage: false })).comments).toBe(2);
    expect(await readFile(out, "utf8")).toContain("Later comment");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("thread creation preserves kind-33358 signature and create_thread", async () => {
  let payload: any;
  const result = await runFlightDeckPgCli(["thread", "create", "--channel", "c", "--body", "Start here", ...auth], {
    fetchImpl: (async (_input, init) => { payload = JSON.parse(String(init?.body)); return json({ thread: { id: "new" } }); }) as typeof fetch,
  });
  expect(result.exitCode).toBe(0); expect(payload.create_thread).toBe(true); expect(payload.thread_id).toBeUndefined();
  expect(payload.message_signature.kind).toBe(33358); expect(verifyEvent(payload.message_signature.nostr_event)).toBe(true);
});

test("thread rename sends captured row version and verifies readback", async () => {
  const requests: string[] = [];
  const c = client((async (_input, init) => {
    requests.push(init?.method ?? "GET");
    if (init?.method === "PATCH") {
      expect(JSON.parse(String(init.body))).toEqual({ title: "Renamed", row_version: 3 });
      return json({ thread: { id: "th", title: "Renamed", row_version: 4 } });
    }
    return json({ thread: { id: "th", title: requests.length === 1 ? "Old" : "Renamed", row_version: requests.length === 1 ? 3 : 4 } });
  }) as typeof fetch);
  expect(await c.renameThread("w", "th", "Renamed")).toMatchObject({ verified: true });
  expect(requests).toEqual(["GET", "PATCH", "GET"]);
  const conflict = client((async (_input, init) => init?.method === "PATCH" ? json({ code: "stale_row_version", error: "stale" },) : json({ thread: { id: "th", row_version: 0 } })) as typeof fetch);
  await expect(conflict.renameThread("w", "th", "Title")).rejects.toThrow("row_version");
});

test("file download verifies binary bytes, refuses corrupt bytes and never overwrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "file-download-"));
  const bytes = new Uint8Array([0, 1, 255, 10]);
  let corrupt = false;
  let requests = 0;
  const c = client((async (input, init) => {
    requests++;
    expect(String(input)).toBe("https://tower.test/api/v4/flightdeck-pg/workspaces/w/files/f/object");
    expect(new Headers(init?.headers).get("authorization")).toStartWith("Nostr ");
    return json({ object: { encoding: "base64", base64_data: Buffer.from(bytes).toString("base64"), size_bytes: bytes.length, sha256_hex: corrupt ? "0".repeat(64) : hash(bytes), download_url: "https://untrusted.invalid/" } });
  }) as typeof fetch);
  try {
    const out = join(dir, "bytes.bin");
    await c.downloadFile("w", "f", out);
    expect(new Uint8Array(await readFile(out))).toEqual(bytes);
    await expect(c.downloadFile("w", "f", out)).rejects.toThrow("EEXIST");
    corrupt = true;
    await expect(c.downloadFile("w", "f", join(dir, "corrupt.bin"))).rejects.toThrow("verification");
    expect(await Bun.file(join(dir, "corrupt.bin")).exists()).toBe(false);
    expect(requests).toBe(3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const payload of [
  { comments: [] }, { comments: [], next_cursor: 17 }, { comments: [], next_cursor: "" },
  { comments: [], next_cursor: null, has_more: true }, { comments: [], next_cursor: "next", has_more: false },
  { comments: null, next_cursor: null },
]) test(`malformed comment envelope fails at real client boundary: ${JSON.stringify(payload)}`, async () => {
  const c = client((async () => json(payload)) as typeof fetch);
  await expect(c.listTaskComments("w", "t", 1, null, true)).rejects.toThrow("Comment page");
  await expect(c.listDocComments("w", "d", 1, null, true)).rejects.toThrow("Comment page");
});
