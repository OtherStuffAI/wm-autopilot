#!/usr/bin/env bun
import { callCapabilityBroker } from "../src/mcp/capability-client";

const [command, credentialRef, model = "kimi-k3-1-pro", revision = "0"] = process.argv.slice(2);
if (command !== "status" && command !== "test" && command !== "configure") {
  console.log("Usage: bun clis/model-provider.ts status | test | configure <saved-secret-ref> [model] [expected-revision]\nUses the calling session broker identity/workspace; never accepts credential values.");
  process.exit(command ? 1 : 0);
}
if (command === "configure" && (!credentialRef || !/^[0-9]+$/.test(revision))) throw new Error("Saved reference and expected revision required");
const result = await callCapabilityBroker("/api/mcp/capabilities/model-provider", command !== "configure" ? { operation: command } : {
  operation: "configure", credentialRef, models: [model], revision: Number(revision), enabled: true,
});
console.log(JSON.stringify(result, null, 2));
