import { probeMeshIngress } from "./fips-ingress-probe";
import { createHash } from "node:crypto";
import { generateSecretKey, finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { callCapabilityBroker } from "../../src/mcp/capability-client";
import { FlightDeckPgClient, resolveFlightDeckPgConfig } from "../../src/flightdeck-pg/client";
import { signFlightDeckPgBotRequest, acquireFlightDeckPgEditLease, updateFlightDeckPgDocument } from "../../src/agent-chat/tower-client";
import { flightDeckDocumentBase } from "../../src/agent-chat/flightdeck-document-base";
import { TowerTransport } from "../../src/agent-chat/tower-transport";

if (Bun.env.WINGMAN_ISOLATED_TEST_RUNTIME !== "1" || !Bun.env.FIPS_ACCEPTANCE_PROBES) throw new Error("Isolated FIPS probe required");
// Respect the production broker's 120 calls/minute policy. Pace this dense
// acceptance probe instead of widening grants or retrying ambiguous writes.
const brokerOrigin = new URL(Bun.env.WINGMAN_BROKER_URL || Bun.env.WINGMAN_URL!).origin;
const originalFetch = globalThis.fetch;
let nextBrokerCallAt = 0;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin === brokerOrigin) {
    const waitMs = Math.max(0, nextBrokerCallAt - Date.now());
    nextBrokerCallAt = Math.max(Date.now(), nextBrokerCallAt) + 650;
    if (waitMs) await Bun.sleep(waitMs);
  }
  return originalFetch(input, init);
}, originalFetch);
const assert = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason); };
const context = await callCapabilityBroker<any>("/api/mcp/wingman/flightdeck", { action: "context" });
const config = resolveFlightDeckPgConfig({ towerUrl: context.workspace.backendBaseUrl,
  appNpub: context.workspace.sourceAppNpub, botCrypto: true, initialContext: context });
const client = new FlightDeckPgClient(config);
const cli = Bun.spawn(["bun", "/app/clis/wingman.ts", "flightdeck", "members", "list", "--workspace", context.workspace.workspaceId, "--json"],
  { env: process.env, stdout: "pipe", stderr: "pipe" });
const [cliOutput, cliError, cliCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
assert(cliCode === 0, `Real broker CLI failed: ${cliError.slice(-300)}`);
assert(Array.isArray(JSON.parse(cliOutput).members), "Real CLI omitted workspace members");
const transport = config.botIdentity.towerTransport!;
assert(transport, "Child CLI did not resolve the host transport");
const workspace = context.workspace.workspaceId;
const path = `/api/v4/flightdeck-pg/workspaces/${workspace}/me`;
const target = await transport.prepare(new URL(path, config.towerUrl).href);
assert(new URL(target).hostname.endsWith(".fips"), "Child CLI selected public Tower");
const authorization = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url: target, method: "GET" });
const headers = { authorization, "x-flightdeck-pg-app-npub": config.appNpub };
const me = await transport.fetch(target, { headers });
assert(me.ok, "Child host-transport workspace read failed");
const identity = await me.json() as any;
const service = identity.identity?.tower_service_npub;
assert(service, "Tower me omitted service identity");
const native = new TowerTransport(config.towerUrl, { mode: "fips", httpsEndpoint: null,
  fipsEndpoint: new URL(target).origin, expectedServiceNpub: service });
const results: Record<string, unknown> = { childPid: process.pid, sessionId: Bun.env.SESSION_ID,
  selectedTarget: target, workspaceRead: true, actualCliMembersRead: true, signedBy: config.botIdentity.botNpub };
async function rejects(name: string, operation: () => Promise<unknown>, expected: RegExp) {
  let rejected = false;
  try { await operation(); } catch (error) { rejected = expected.test(String(error)); }
  assert(rejected, `${name} was not rejected`); results[name] = { rejected: true, expected: expected.source };
}
await rejects("unapprovedDestination", () => transport.prepare("https://unapproved.example/api/v4/flightdeck-pg/workspaces/x/me"), /outside the approved connection/);
const outsiderKey = generateSecretKey();
const outsiderNpub = nip19.npubEncode(getPublicKey(outsiderKey));
const wrong = new TowerTransport(config.towerUrl, { mode: "fips", httpsEndpoint: null,
  fipsEndpoint: new URL(target).origin, expectedServiceNpub: outsiderNpub });
await rejects("incorrectService", () => wrong.prepare(target), /service identity mismatch/); wrong.close();
const outsider = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
  tags: [["u", target], ["method", "GET"]] }, outsiderKey);

const denied = await native.fetch(target, { headers: { ...headers,
  authorization: `Nostr ${Buffer.from(JSON.stringify(outsider)).toString("base64")}` } });
assert(denied.status === 403, `Outsider workspace access returned ${denied.status}`);
await denied.body?.cancel(); results.deniedWorkspace = denied.status;
const wrongTarget = await native.fetch(`${target}?tampered=1`, { headers });
assert(wrongTarget.status === 401, "Tower accepted mismatched exact NIP-98 target");
await wrongTarget.body?.cancel(); results.exactTargetRejected = wrongTarget.status;
const writeTarget = new URL(`/api/v4/flightdeck-pg/workspaces/${workspace}/storage/prepare`, target).href;
const body = JSON.stringify({ file_name: "body-probe.txt", content_type: "text/plain", size_bytes: 1 });
const writeAuth = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url: writeTarget, method: "POST", body });
const wrongBody = await native.fetch(writeTarget, { method: "POST", body: body + " ", headers: { ...headers,
  authorization: writeAuth, "content-type": "application/json" } });
assert(wrongBody.status === 401, "Tower accepted mismatched NIP-98 bytes");
await wrongBody.body?.cancel(); results.exactBodyRejected = wrongBody.status;
for (const [name, changed] of [["wrongMeshPort", target.replace(":43100", ":43103")],
  ["wrongMeshNode", target.replace(new URL(target).hostname, `${outsiderNpub}.fips`)]] as const) {
  await rejects(name, () => transport.prepare(changed), /outside the approved connection/);
}
for (const [name, added] of [["forgedForwarding", { "x-forwarded-host": "unapproved.example" }],
  ["wrongHost", { host: "unapproved.example" }]] as const) {
  await rejects(name, () => transport.fetch(target, { headers: { ...headers, ...added } }), /forwarding headers cannot override/);
}
const methodAuth = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url: writeTarget, method: "GET" });
const changedMethod = await native.fetch(writeTarget, { method: "POST", headers: { ...headers, authorization: methodAuth } });
assert(changedMethod.status === 401, "Tower accepted changed signed method");
await changedMethod.body?.cancel(); results.changedMethodRejected = 401;
const ordered = target + "?a=1&b=2";
const orderedAuth = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url: ordered, method: "GET" });
const reordered = await native.fetch(target + "?b=2&a=1", { headers: { ...headers, authorization: orderedAuth } });
assert(reordered.status === 401, "Tower accepted reordered signed query");
await reordered.body?.cancel(); results.reorderedQueryRejected = 401;
const preparedAuth = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url: writeTarget, method: "POST", body });
const preparedResponse = await transport.fetch(writeTarget, { method: "POST", body, headers: { ...headers, authorization: preparedAuth, "content-type": "application/json" } });
assert(preparedResponse.ok, "Incomplete-object fixture preparation failed");
const prepared = await preparedResponse.json() as any;
for (const [name, objectId, status] of [["incompleteObject", prepared.object_id, 409], ["missingObject", "00000000-0000-4000-8000-000000000001", 404]] as const) {
  const url = new URL(`/api/v4/storage/${objectId}/content`, target).href;
  const authorization = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url, method: "GET" });
  const response = await transport.fetch(url, { headers: { ...headers, authorization } });
  assert(response.status === status, `${name} returned ${response.status}`);
  await response.body?.cancel(); results[name] = status;
}
const bytes = `FIPS attachment from ${Bun.env.SESSION_ID}\n`;
const localFile = `/app/data/isolated-test/attachment-${Bun.env.SESSION_ID}.txt`;
await Bun.write(localFile, bytes);
const uploaded = await client.uploadFile(workspace, context.chat.channelId, localFile, "text/plain") as any;
const file = uploaded.file;
assert(file?.storage_object_id, "File publication omitted storage object id");
const contentTarget = new URL(`/api/v4/storage/${file.storage_object_id}/content`, target).href;
const contentAuth = await signFlightDeckPgBotRequest({ botIdentity: config.botIdentity, url: contentTarget, method: "GET" });
const content = await transport.fetch(contentTarget, { headers: { ...headers, authorization: contentAuth, "x-workspace-id": workspace } });
assert(content.ok, `Attachment content read failed (${content.status})`);
assert(await content.text() === bytes, "Attachment bytes differ");
for (const suffix of ["", "/content"]) {
  const url = new URL(`/api/v4/storage/${file.storage_object_id}${suffix}`, target).href;
  const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
    tags: [["u", url], ["method", "GET"]] }, outsiderKey);
  const response = await native.fetch(url, { headers: { ...headers, authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}` } });
  assert(response.status === 404, `Private storage outsider ${suffix || "metadata"} returned ${response.status}`);
  await response.body?.cancel();
}
results.ingress = await probeMeshIngress(target, config.towerUrl, outsiderKey);
outsiderKey.fill(0); results.storageAclRejected = true;
results.attachment = { fileId: file.id, objectId: file.storage_object_id, sha256: createHash("sha256").update(bytes).digest("hex") };
const docBody = `Attachment: storage://${file.storage_object_id}`;
const createdDoc = await client.createDoc(workspace, context.chat.channelId, "FIPS acceptance document", docBody);
const docId = String(createdDoc.doc?.id || "");
assert(docId, "Document create omitted id");
const stale = await client.showDoc(workspace, docId, false);
await client.updateDoc(workspace, docId, `${docBody}\nVerified update.`);
const canonical = await client.showDoc(workspace, docId, false);
const canonicalBody = await client.showDoc(workspace, docId, true);
const base = { backendBaseUrl: config.towerUrl, workspaceId: workspace, appNpub: config.appNpub, botIdentity: config.botIdentity };
const lease = await acquireFlightDeckPgEditLease({ ...base, entityType: "document", entityId: docId });
assert(Number.isInteger(stale.doc?.row_version) && lease.lease?.lease_token, "Conflict fixture missing base or lease");
let conflict: any;
try { await updateFlightDeckPgDocument({ ...base, documentId: docId, body: "Stale concurrent content", rowVersion: stale.doc!.row_version!,
  leaseToken: lease.lease!.lease_token!, ...flightDeckDocumentBase(stale) }); } catch (error) { conflict = error; }
assert(conflict?.status === 409 && conflict?.detailCode === "document_recovery_created", "Stale document save did not preserve a recovery");
const retained = await client.showDoc(workspace, docId, false);
const retainedBody = await client.showDoc(workspace, docId, true);
assert(canonical.canonical_version?.version_id && retained.canonical_version?.version_id === canonical.canonical_version.version_id && retainedBody.body_text === canonicalBody.body_text, "Conflict changed canonical document head");
results.documentConflict = { status: conflict.status, code: conflict.detailCode, canonicalVersion: retained.canonical_version?.version_id };
await client.replyDoc(workspace, docId, "Verified FIPS document comment.");
const downloaded = await client.downloadDoc(workspace, docId, `/app/data/isolated-test/document-${Bun.env.SESSION_ID}.md`);
assert(downloaded.storageDownloads.length === 1 && downloaded.comments === 1, "Document/attachment download was incomplete");
const createdTask = await client.createTask(workspace, context.chat.channelId, { title: "FIPS acceptance task", description: "Transport verification; no worker dispatch requested." });
const taskId = String((createdTask as any).task?.id || "");
assert(taskId, "Task create omitted id");
await client.commentTask(workspace, taskId, "Verified FIPS task comment.");
await client.updateTaskState(workspace, taskId, "ready");
assert((await client.showTask(workspace, taskId)).task?.state === "ready", "Task state did not persist");
const comments = await client.listTaskComments(workspace, taskId);
assert(comments.comments.length === 1, "Task comment read was incomplete");
results.documents = { docId, attachmentDownloads: downloaded.storageDownloads.length, comments: downloaded.comments };
results.tasks = { taskId, comments: comments.comments.length };
native.close();
await Bun.write(`/app/data/isolated-test/fips-probe-${Bun.env.SESSION_ID}.json`, JSON.stringify(results));
