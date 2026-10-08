#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { requestJsonBotCrypto, resolveBaseUrl } from "./lib/auth.ts";
import { callCapabilityBroker } from "../src/mcp/capability-client.ts";
import { bindScheduledFlightDeckContext, scheduledContextSchema } from "../src/flightdeck-pg/scheduled-context.ts";

async function main(): Promise<void> {
  const [flag, path, ...extra] = Bun.argv.slice(2);
  if (flag !== "--config" || !path || extra.length) {
    throw new Error("Usage: bun clis/bind-scheduled-flightdeck.ts --config <private-route.json>");
  }
  const sessionId = Bun.env.SESSION_ID?.trim();
  if (!sessionId || !Bun.env.WINGMAN_CAPABILITY?.trim()) {
    throw new Error("A brokered scheduled session is required.");
  }
  const wingmanUrl = resolveBaseUrl();
  const context = await bindScheduledFlightDeckContext({
    sessionId,
    config: scheduledContextSchema.parse(JSON.parse(readFileSync(path, "utf8"))),
    request: (method, route, body) => requestJsonBotCrypto(wingmanUrl, method, route, body),
    context: () => callCapabilityBroker("/api/mcp/wingman/flightdeck", { action: "context" }),
  });
  console.log(JSON.stringify({ ok: true, sessionId, context }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
