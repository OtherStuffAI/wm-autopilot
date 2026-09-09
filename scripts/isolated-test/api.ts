import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, nip19 } from "nostr-tools";

if (process.env.WINGMAN_ISOLATED_TEST_RUNTIME !== "1" || !existsSync("/.dockerenv")) {
  throw new Error("Bootstrap API client is restricted to the isolated Docker runtime");
}
const healthCheck = process.argv[2] === "--health";
const [method = "GET", path = "/api/agent-chat/agents"] = healthCheck ? [] : process.argv.slice(2);
if (!path.startsWith("/api/") || path.startsWith("//") || !["GET", "POST", "PATCH", "DELETE"].includes(method)) {
  throw new Error("Expected METHOD /api/path; JSON body is read from stdin");
}
const body = method === "GET" ? undefined : await Bun.stdin.text();
const identity = JSON.parse(readFileSync("/app/data/isolated-test/bootstrap.json", "utf8"));
const decoded = nip19.decode(String(identity.nsec));
if (decoded.type !== "nsec") throw new Error("Invalid generated bootstrap identity");
const url = new URL(path, process.env.WINGMAN_BASE_URL);
const tags = [["u", url.href], ["method", method], ["nonce", randomUUID()]];
if (body) tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, decoded.data);
decoded.data.fill(0);
const response = await fetch(new URL(path, "http://127.0.0.1:3600"), {
  method, body,
  headers: { "Content-Type": "application/json", Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` },
});
const text = await response.text();
if (!response.ok) throw new Error(`Bootstrap API returned ${response.status}: ${text}`);
if (healthCheck) {
  const result = JSON.parse(text);
  if (!result.defaults?.defaultAgentProfileId || !result.agents?.some(
    (agent: { agentId: string; botNpub: string }) => agent.agentId === result.defaults.defaultAgentProfileId && agent.botNpub,
  )) throw new Error("Isolated runtime has no default agent identity");
} else {
  process.stdout.write(`${text}\n`);
}
