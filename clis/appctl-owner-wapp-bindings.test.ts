import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { generateSecretKey, nip19, verifyEvent } from "nostr-tools";

test("appctl routes Tower binding commands through exact owner-space paths", async () => {
  const requests: Array<{ request: Request; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      requests.push({ request: new Request(request.url, { method: request.method, headers: request.headers }), body });
      if (request.method === "GET") return Response.json({ bindings: [], defaultBinding: null });
      return Response.json({ binding: { id: "binding-1" } }, { status: request.method === "POST" ? 201 : 200 });
    },
  });
  const owner = "npub1owner";
  const env = {
    ...process.env,
    SESSION_ID: "",
    WINGMAN_CAPABILITY: "",
    WINGMAN_NSEC: nip19.nsecEncode(generateSecretKey()),
  };
  const cases = [
    ["tower-bindings", "GET", `/api/owners/${owner}/wapps/tower-bindings`, []],
    ["tower-binding-create", "POST", `/api/owners/${owner}/wapps/tower-bindings`, [
      "--name", "Freedom data", "--tower-url", "https://tower.example", "--workspace-owner-npub", owner,
    ]],
    ["tower-binding-default", "PATCH", `/api/owners/${owner}/wapps/tower-bindings/binding-1`, ["binding-1"]],
  ] as const;
  try {
    for (const [command, method, pathname, commandArgs] of cases) {
      const child = Bun.spawn([
        process.execPath,
        "clis/appctl.ts",
        command,
        ...commandArgs,
        "--owner",
        owner,
        "--url",
        server.url.toString(),
        "--json",
      ], { env, stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(stderr).toBe("");
      const observed = requests.at(-1)!;
      expect(observed.request.method).toBe(method);
      expect(new URL(observed.request.url).pathname).toBe(pathname);
      const event = JSON.parse(Buffer.from(observed.request.headers.get("authorization")!.slice(6), "base64").toString());
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toContainEqual(["u", observed.request.url]);
      expect(event.tags).toContainEqual(["method", method]);
      if (observed.body) {
        expect(event.tags).toContainEqual(["payload", createHash("sha256").update(observed.body).digest("hex")]);
      } else {
        expect(event.tags.some((tag: string[]) => tag[0] === "payload")).toBe(false);
      }
    }
  } finally {
    await server.stop(true);
  }
});
