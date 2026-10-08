#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { FlightDeckPgClient, resolveFlightDeckPgConfig } from "../src/flightdeck-pg/client.ts";
import { fetchFlightDeckDispatchContext } from "../src/flightdeck-pg/cli.ts";
import { scanTasks, scanSummary, signature, record, assertDispatchWorkspace, type ScanConfig, type ScanResult } from "../src/flightdeck-pg/consolidation/scan.ts";
import { atomicJson, readJson, verifyEvidencePath, withRunLock } from "../src/flightdeck-pg/consolidation/storage.ts";
import { saveFindings, deliverDigest, type ReviewedFindings, type DeliveryState } from "../src/flightdeck-pg/consolidation/checkpoint.ts";
import { linkExistingTask, reconcileProposal, type WriteIntent } from "../src/flightdeck-pg/consolidation/reconcile.ts";

const help = `Bounded proposal-only consolidation helper (broker authentication required)
Usage: bun clis/consolidate-bugs.ts <scan|finalize|link|proposal|deliver> --root <ignored existing state directory> [options]
  scan --out <ignored evidence.json>         Read-only live scan; no checkpoint/task/DM writes
       --persist                            Persist retry-safe scan resume under the existing lock
       --resume                             Resume saved incomplete scan; fresh map/ACL checks
       --page-size 100 --max-pages 50 --max-requests 80
  finalize --input <review.json>             Save reviewed incidents/groups, then eligible checkpoint
  link --input <link.json>                   Read fresh task/comments; add an exact link once
  proposal --input <proposal.json>           Complete scan and durable uncertain-create reconciliation
  deliver --input <digest.json>              Separate verified outbox; unchanged digests suppressed
Required root/config.json: workspace_id, scope_id, approved channels [{id,name,scope_id}],
  delivery {channel_id,thread_id}. No global workspace enumeration. A full 200-channel list is partial.
All mutable commands acquire existing root/lock. Occupied locks are never removed or expired.
Dry scan output is private evidence; stdout contains counts/reason codes only.
Review input requires state_signature, scan_signature, incidents_complete, reconciliation_complete,
  groups, incident_evidence, unresolved_questions, recommendation and optional blocker.
Link input: channel_id, task_id, body. Proposal input: channel_id, key (stable boundary), source_ids, matching_task_ids, distinct_task_reasons, title, body (awaiting Pete).
Digest input: kind (recommendation|blocker), material, body. Pending ambiguous writes never blindly retry.
No implementation dispatch, session intervention, state reassignment, application restart or raw keys.`;

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const command = args.shift();
  if (!command || command === "--help") { console.log(help); return; }
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error("Missing argument");
    return args[i + 1];
  };
  const rootInput = flag("--root");
  if (!rootInput) throw new Error("Missing state root");
  const root = resolve(rootInput);
  await verifyEvidencePath(join(root, "state.json"));
  const config = await readJson(join(root, "config.json")) as unknown as ScanConfig & { delivery: { channel_id: string; thread_id: string } };
  const sessionId = Bun.env.SESSION_ID;
  if (!sessionId || !Bun.env.WINGMAN_CAPABILITY) throw new Error("Broker session required");
  const context = await fetchFlightDeckDispatchContext({ sessionId, wingmanUrl: Bun.env.WINGMAN_URL });
  assertDispatchWorkspace(config, context);
  const workspace = record(context.workspace);
  const client = new FlightDeckPgClient(resolveFlightDeckPgConfig({
    towerUrl: String(workspace.backendBaseUrl ?? ""), appNpub: String(workspace.sourceAppNpub ?? ""),
    wingmanUrl: Bun.env.WINGMAN_URL, sessionId, botCrypto: true, initialContext: context,
  }));
  const statePath = join(root, "state.json");
  const scanPath = join(root, "task-scan.json");
  const input = async () => {
    const path = flag("--input");
    if (!path) throw new Error("Missing input file");
    return await readJson(path);
  };
  let scanRequests = 0;
  let scanPages = 0;
  const scan = async (persist: boolean, useResume = false) => {
    const resume = useResume ? await readJson(scanPath) as unknown as ScanResult : undefined;
    const requestBudget = Number(flag("--max-requests") ?? 80) - scanRequests;
    const pageBudget = Number(flag("--max-pages") ?? 50) - scanPages;
    if (requestBudget < 1 || pageBudget < 1) throw new Error("Scan command budget exhausted");
    const result = await scanTasks(client, config, {
      pageSize: Number(flag("--page-size") ?? 100), maxPages: pageBudget,
      maxRequests: requestBudget, resume,
      save: persist ? s => atomicJson(scanPath, s) : undefined,
    });
    scanRequests += result.requests;
    scanPages += result.pages_read - (resume?.pages_read ?? 0);
    return result;
  };
  if (command === "scan") {
    const out = flag("--out");
    if (!out) throw new Error("Dry scan requires ignored output destination");
    await verifyEvidencePath(out);
    const run = async (persist: boolean) => {
      const continued = await scan(persist, args.includes("--resume"));
      if (!continued.continuation_complete) return continued;
      // A single fresh verification pass shares the command budget; never loop.
      const remainingRequests = Number(flag("--max-requests") ?? 80) - scanRequests;
      const remainingPages = Number(flag("--max-pages") ?? 50) - scanPages;
      if (remainingRequests < 1 || remainingPages < 1) return continued;
      return await scan(persist);
    };
    const result = args.includes("--persist") ? await withRunLock(root, sessionId, () => run(true)) : await run(false);
    await atomicJson(out, result);
    console.log(JSON.stringify({ ...scanSummary(result), command_requests: scanRequests, command_pages: scanPages }));
    if (!result.complete) process.exitCode = 2;
    return;
  }
  await withRunLock(root, sessionId, async () => {
    if (command === "finalize") {
      const state = await readJson(statePath);
      const findings = await input();
      if (findings.state_signature !== signature(state)) throw new Error("State changed since review");
      const result = await saveFindings(state, await readJson(scanPath) as unknown as ScanResult,
        findings as unknown as ReviewedFindings, s => atomicJson(statePath, s));
      console.log(JSON.stringify({ checkpoint_advanced: result.last_successful_scan !== state.last_successful_scan }));
    } else if (command === "link" || command === "proposal") {
      const payload = await input();
      const channel = String(payload.channel_id ?? "");
      if (!config.channels.some(c => c.id === channel)) throw new Error("Destination outside approved map");
      const body = String(payload.body ?? "");
      if (!body) throw new Error("Missing write body");
      const proposalKey = String(payload.key ?? "");
      if (command === "proposal" && !proposalKey) throw new Error("Missing stable proposal key");
      const intentPath = join(root, `intent-${signature(command === "proposal"
        ? { command, workspace: config.workspace_id, channel, key: proposalKey } : { command, payload })}.json`);
      let intent: WriteIntent;
      try { intent = await readJson(intentPath) as unknown as WriteIntent; }
      catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        intent = { body, attempted: false };
      }
      const persist = (value: WriteIntent) => atomicJson(intentPath, value);
      if (command === "link") {
        const task = String(payload.task_id ?? "");
        const result = await linkExistingTask(client, { workspace: config.workspace_id, channel, task, body }, intent, persist);
        console.log(JSON.stringify({ link: result }));
        if (result === "uncertain") process.exitCode = 2;
      } else {
        if (!body.includes("Proposed remediation, awaiting Pete's decision; implementation not authorised.")) throw new Error("Proposal authority missing");
        const result = await reconcileProposal(client, { workspace: config.workspace_id, channel, body, key: proposalKey, title: String(payload.title ?? ""),
          sourceIds: payload.source_ids as string[], matchingTaskIds: payload.matching_task_ids as string[] | undefined,
          distinctTaskReasons: payload.distinct_task_reasons as Record<string, string> | undefined }, intent,
          async () => { const s = await scan(false); if (!s.complete) throw new Error("Proposal scan incomplete"); return s.tasks; }, persist);
        console.log(JSON.stringify({ proposal_verified: Boolean(result), uncertain: !result }));
        if (!result) process.exitCode = 2;
      }
    } else if (command === "deliver") {
      const payload = await input();
      if (payload.kind !== "recommendation" && payload.kind !== "blocker") throw new Error("Invalid digest kind");
      if (!config.delivery?.channel_id || !config.delivery.thread_id) throw new Error("Missing authorised delivery destination");
      const path = join(root, "delivery.json");
      let state: DeliveryState;
      try { state = await readJson(path) as DeliveryState; }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; state = {}; }
      const body = String(payload.body ?? "");
      if (!body) throw new Error("Missing digest body");
      const result = await deliverDigest(state, { kind: payload.kind, material: payload.material, body }, {
        readback: async text => {
          const history = await client.readThread(config.workspace_id, config.delivery.channel_id, config.delivery.thread_id, 200);
          return history.messages.some(m => m.body === text && m.sender_npub === Bun.env.BOT_NPUB);
        },
        send: async text => { await client.reply(config.workspace_id, config.delivery.channel_id, config.delivery.thread_id, text); },
      }, s => atomicJson(path, s));
      console.log(JSON.stringify({ delivery: result }));
      if (result === "uncertain") process.exitCode = 2;
    } else throw new Error("Unknown command");
  });
}

if (import.meta.main) main().catch((error: unknown) => {
  const safeMessages = new Set([
    "Schedule lock occupied; leave its owner untouched", "Lock ownership changed; leave it untouched",
    "Operational evidence must be ignored and untracked", "Symlink evidence destination",
    "State changed since review", "Review does not match current scan", "Missing reviewed findings",
    "Invalid checkpoint timestamp", "Comment reconciliation incomplete",
    "Task changed; reconcile fresh task/comments before writing", "Proposal scan incomplete",
    "Existing source task requires semantic reconciliation", "Matching task no longer readable",
    "Scan command budget exhausted", "Reconcile pending digest before replacing it", "Pending digest body changed",
    "scan_persistence_failed", "Invalid resume or map changed", "Configured workspace does not match dispatch workspace",
  ]);
  const status = (error as { status?: number; statusCode?: number })?.status
    ?? (error as { statusCode?: number })?.statusCode;
  const reason = error instanceof Error && safeMessages.has(error.message) ? error.message
    : status === 401 || status === 403 ? "access_denied" : status === 429 ? "rate_limit" : "consolidation_operation_failed";
  // Errors may contain private URLs, identifiers, broker responses or payloads.
  console.error(JSON.stringify({ complete: false, error: reason, action: "Inspect authorised private evidence; do not retry uncertain writes blindly" }));
  process.exitCode = 1;
});
