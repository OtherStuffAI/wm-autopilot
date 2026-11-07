import { expect, test } from "bun:test";
import { completedDailyReportWindow, readOwnPrivateHistory, sendPrivateReport, type PrivateReportRequest, requirePrivateReportContext } from "./private-report";
const context = requirePrivateReportContext({ workspace: { workspaceId: "10000000-0000-4000-8000-000000000001", backendBaseUrl: "https://tower.test", sourceAppNpub: "app" }, bot: { npub: "violet", available: true } });
function fixture(existing = true) {
  const channel = { id: "private", kind: "dm", participant_npubs: ["violet", "parent"] };
  const rows: any[] = [];
  const writes: any[] = [];
  const request: PrivateReportRequest = async (method, path, body: any) => {
    if (method === "POST") {
      writes.push({ path, body });
      if (path.includes("/scopes/")) return { channel };
      rows.push({ id: "saved", body: body.body, sender_npub: "violet", client_request_id: body.client_request_id });
      return { message: rows.at(-1) };
    }
    if (path.includes("/messages")) return { channel_id: "private", messages: rows, next_cursor: null, cursor_semantics: { order: "created_at ASC, id ASC" } };
    if (path.includes("/channels?")) return { channels: [
      ...(existing ? [channel] : []),
      { id: "rick-pilot-test", kind: "dm", participant_npubs: ["rick", "violet"] },
      { id: "unrelated", kind: "dm", participant_npubs: ["rick", "parent"] },
      { id: "public", kind: "channel", participant_npubs: ["violet", "parent"] },
    ], next_cursor: null };
    if (path.endsWith("/channels/private")) return { channel };
    if (path.includes("/scopes?")) return { scopes: [{ id: "dm-scope", kind: "dm" }], next_cursor: null };
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { channel, rows, writes, request };
}
const report = { recipient: "parent", body: "Bounded private update", clientRequestId: "daily-violet-parent-2026-11-06" };
test("dry run never creates or sends; test channel cannot become parent destination", async () => {
  const f = fixture(false);
  expect(await sendPrivateReport(context, f.request, { ...report, dryRun: true })).toMatchObject({ delivered: false, channelId: null, action: "create_exact_private_pair" });
  expect(f.writes).toEqual([]);
});
test("send verifies exact pair and saved bot-authored receipt; retry is duplicate safe", async () => {
  const f = fixture();
  expect(await sendPrivateReport(context, f.request, report)).toMatchObject({ delivered: true, messageId: "saved", reused: false });
  expect(await sendPrivateReport(context, f.request, report)).toMatchObject({ delivered: true, reused: true });
  expect(f.writes).toHaveLength(1);
  await expect(sendPrivateReport(context, f.request, { ...report, body: "changed" })).rejects.toThrow("unverified");
  expect(f.writes).toHaveLength(1);
});
test("a missing pair uses supported exact-recipient creation and readback", async () => {
  const f = fixture(false);
  expect(await sendPrivateReport(context, f.request, report)).toMatchObject({ delivered: true });
  expect(f.writes[0].body).toMatchObject({ kind: "dm", participant_npubs: ["violet", "parent"] });
});
test("wrong returned recipient or missing delivery receipt fails explicitly", async () => {
  const f = fixture(false); f.channel.participant_npubs = ["violet", "rick"];
  await expect(sendPrivateReport(context, f.request, report)).rejects.toThrow("exact private recipient");
  expect(f.writes).toHaveLength(1);
  const g = fixture(); const original = g.request;
  const noReceipt: PrivateReportRequest = async (method, path, body) => method === "POST" ? {} : original(method, path, body);
  await expect(sendPrivateReport(context, noReceipt, report)).rejects.toThrow("unverified");
});
test("own history follows cursors and filters the exact review window", async () => {
  const f = fixture(); let pages = 0;
  const request: PrivateReportRequest = async (method, path, body) => {
    if (path.includes("/messages")) {
      const channel = path.includes("rick-pilot-test") ? "rick-pilot-test" : "private";
      pages++;
      return { channel_id: channel, cursor_semantics: { order: "created_at ASC, id ASC" }, next_cursor: path.includes("cursor=") ? null : "next",
        messages: [{ id: String(pages), created_at: path.includes("cursor=") ? "2026-11-06T04:00:00Z" : "2026-11-04T04:00:00Z", body: "recorded conversation" }] };
    }
    return f.request(method, path, body);
  };
  const result = await readOwnPrivateHistory(context, request, "2026-11-05T12:00:00Z", "2026-11-06T12:00:00Z");
  expect(result.conversations.map(c => c.channelId)).toEqual(["private", "rick-pilot-test"]);
  expect(result.conversations.every(c => c.messages.length === 1)).toBe(true);
  expect(f.writes).toEqual([]);
});
test("incomplete lists and repeated history cursors never become an all-clear", async () => {
  const f = fixture(); const original = f.request;
  const incomplete: PrivateReportRequest = async (method, path, body) => path.includes("/scopes?") ? { scopes: [], next_cursor: "more" } : original(method, path, body);
  await expect(readOwnPrivateHistory(context, incomplete, "2026-11-05", "2026-11-06")).rejects.toThrow("incomplete");
  const repeated: PrivateReportRequest = async (method, path, body) => path.includes("/messages") ? { channel_id: "private", messages: [], cursor_semantics: { order: "created_at ASC, id ASC" }, next_cursor: "same" } : original(method, path, body);
  await expect(readOwnPrivateHistory(context, repeated, "2026-11-05", "2026-11-06")).rejects.toThrow("repeated");
});

test("body-file whitespace is canonicalized before POST and receipt reconciliation", async () => {
  const f = fixture();
  expect(await sendPrivateReport(context, f.request, { ...report, body: `  ${report.body}\n` })).toMatchObject({ delivered: true });
  expect(f.writes[0].body.body).toBe(report.body);
  expect(await sendPrivateReport(context, f.request, report)).toMatchObject({ reused: true });
  expect(f.writes).toHaveLength(1);
});
test("future review windows fail before any request, including empty-history claims", async () => {
  let requests = 0;
  const request: PrivateReportRequest = async () => { requests++; return {}; };
  await expect(readOwnPrivateHistory(context, request, "2026-11-07T12:00:00Z", "2099-11-08T12:00:00Z")).rejects.toThrow("future history");
  expect(requests).toBe(0);
});

test("daily window uses last completed boundary before, at and after 12Z", () => {
  expect(completedDailyReportWindow(12, Date.parse("2026-11-07T23:48:00Z"))).toEqual({ since: "2026-11-06T12:00:00.000Z", until: "2026-11-07T12:00:00.000Z", reportDate: "2026-11-07" });
  expect(completedDailyReportWindow(12, Date.parse("2026-11-08T11:59:59Z"))).toHaveProperty("until", "2026-11-07T12:00:00.000Z");
  expect(completedDailyReportWindow(12, Date.parse("2026-11-08T12:00:00Z"))).toHaveProperty("until", "2026-11-08T12:00:00.000Z");
  expect(() => completedDailyReportWindow(24)).toThrow("boundary hour");
});
