#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { callCapabilityBroker } from "../src/mcp/capability-client";
import { privateReportRequest } from "./lib/flightdeck-private-request";
import { requirePrivateReportContext, readOwnPrivateHistory, sendPrivateReport, completedDailyReportWindow } from "../src/flightdeck-pg/private-report";

async function main() {
  const [command, ...args] = Bun.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--dry-run") { flags.set(key, "true"); continue; }
    if (!key.startsWith("--") || !args[i + 1]) throw new Error("Expected named options with values.");
    flags.set(key, args[++i]!);
  }
  if (command === "window") {
    const hour = flags.get("--boundary-hour-utc");
    if (hour === undefined) throw new Error("--boundary-hour-utc is required");
    console.log(JSON.stringify(completedDailyReportWindow(Number(hour)), null, 2));
    return;
  }
  const context = requirePrivateReportContext(await callCapabilityBroker("/api/mcp/wingman/flightdeck", { action: "context" }));
  const request = privateReportRequest(context);
  if (command === "history") {
    console.log(JSON.stringify(await readOwnPrivateHistory(context, request, flags.get("--since") ?? "", flags.get("--until") ?? ""), null, 2));
    return;
  }
  if (command !== "send") throw new Error("Usage: flightdeck-private-report.ts window --boundary-hour-utc HOUR | history --since ISO --until ISO | send --recipient npub --body-file PATH --client-request-id ID [--dry-run]");
  const bodyFile = flags.get("--body-file"); if (!bodyFile) throw new Error("--body-file is required");
  console.log(JSON.stringify(await sendPrivateReport(context, request, { recipient: flags.get("--recipient") ?? "",
    body: readFileSync(bodyFile, "utf8"), clientRequestId: flags.get("--client-request-id") ?? "", dryRun: flags.has("--dry-run") }), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
