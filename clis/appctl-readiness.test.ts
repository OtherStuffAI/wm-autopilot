import { expect, test } from "bun:test";
import { generateSecretKey, nip19, verifyEvent } from "nostr-tools";

for (const ready of [true, false]) {
  test(`appctl readiness signs exact GET and exits ${ready ? 0 : 1}`, async () => {
    const requests: Request[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new Request(request.url, { method: request.method, headers: request.headers }));
        return Response.json({ ready, code: ready ? "ready" : "publisher_custody_unavailable", evidence: {} });
      },
    });
    try {
      const child = Bun.spawn([
        process.execPath, "clis/appctl.ts", "wapp-publisher-readiness", "installation-1",
        "--scope-id", "scope-1", "--channel-id", "channel-1", "--origin", "https://book.example",
        "--owner", "npub1owner", "--url", server.url.toString(), "--json",
      ], {
        env: { ...process.env, SESSION_ID: "", WINGMAN_CAPABILITY: "", WINGMAN_NSEC: nip19.nsecEncode(generateSecretKey()) },
        stdout: "pipe", stderr: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toBe("");
      expect(await child.exited).toBe(ready ? 0 : 1);
      expect(JSON.parse(stdout)).toMatchObject({ ready });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/api/owners/npub1owner/wapps/installation-1/publisher-readiness");
      expect(Object.fromEntries(url.searchParams)).toEqual({ scope_id: "scope-1", channel_id: "channel-1", origin: "https://book.example" });
      const event = JSON.parse(Buffer.from(request.headers.get("authorization")!.slice(6), "base64").toString());
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toContainEqual(["u", request.url]);
      expect(event.tags).toContainEqual(["method", "GET"]);
    } finally { await server.stop(true); }
  });
}
