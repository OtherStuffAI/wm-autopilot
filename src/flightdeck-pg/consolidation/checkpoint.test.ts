import { expect, test } from "bun:test";
import { saveFindings, deliverDigest, type DeliveryState, type ReviewedFindings } from "./checkpoint.ts";
import { signature, type ScanResult, type RecordData } from "./scan.ts";

const scan: ScanResult = { config_signature: "c", started_at: "2026-10-08T00:00:00Z", complete: true, channels_checked: 2,
  pages_read: 4, requests: 7, tasks: [], gaps: [], progress: {} };
function findings(s = scan): ReviewedFindings {
  return { scan_signature: signature(s), incidents_complete: true, reconciliation_complete: true,
    groups: [{ id: "source", implementation_thread: "specific-batch" }], incident_evidence: [], unresolved_questions: {}, recommendation: "same" };
}
test("groups/links save precedes one checkpoint advancement, unchanged finalized run does not advance again", async () => {
  const writes: RecordData[] = [];
  const persist = async (s: RecordData) => { writes.push(structuredClone(s)); };
  const state = await saveFindings({ last_successful_scan: "2026-10-07T00:00:00Z" }, scan, findings(), persist);
  expect(writes[0]?.groups).toEqual(findings().groups);
  expect(writes[0]?.last_successful_scan).toBe("2026-10-07T00:00:00Z");
  expect(writes[1]?.last_successful_scan).toBe(scan.started_at);
  writes.length = 0;
  await saveFindings(state, scan, findings(), persist);
  expect(writes.length).toBe(1);
});
test("partial tasks/incident review/reconciliation or persistence failure preserve checkpoint", async () => {
  for (const incomplete of ["scan", "incidents", "reconciliation"]) {
    const s = { ...scan, complete: incomplete !== "scan" };
    const f = { ...findings(s), incidents_complete: incomplete !== "incidents", reconciliation_complete: incomplete !== "reconciliation" };
    const writes: RecordData[] = [];
    await saveFindings({ last_successful_scan: "2026-10-07T00:00:00Z" }, s, f, async value => { writes.push(value); });
    expect(writes.length).toBe(1);
    expect(writes[0]?.last_successful_scan).toBe("2026-10-07T00:00:00Z");
  }
  let count = 0;
  await expect(saveFindings({ last_successful_scan: "2026-10-07T00:00:00Z" }, scan, findings(), async () => { count++; throw new Error("disk full"); })).rejects.toThrow();
  expect(count).toBe(1);
});
test("failed DM uses separate durable attempted state, never blind retries, and reconciles late delivery", async () => {
  let saved: DeliveryState = {};
  let sends = 0;
  let delivered = false;
  const transport = { readback: async () => delivered, send: async () => { sends++; throw new Error("response lost"); } };
  const input = { kind: "recommendation" as const, material: { decision: "new" }, body: "specific digest" };
  const persist = async (value: DeliveryState) => { saved = structuredClone(value); };
  expect(await deliverDigest(saved, input, transport, persist)).toBe("uncertain");
  expect(saved.pending?.attempted).toBe(true);
  expect(saved.delivered_signature).toBeUndefined();
  expect(await deliverDigest(saved, input, transport, persist)).toBe("uncertain");
  expect(sends).toBe(1);
  delivered = true;
  expect(await deliverDigest(saved, input, transport, persist)).toBe("delivered");
  expect(await deliverDigest(saved, input, transport, persist)).toBe("unchanged");
  expect(sends).toBe(1);
});
test("DM checkpoint save failure recovers via readback; changed blocker throttled independently", async () => {
  let sends = 0;
  let delivered = false;
  let saved: DeliveryState = {};
  const input = { kind: "blocker" as const, material: "access", body: "blocker", now: 1_800_000_000_000 };
  const transport = { readback: async () => delivered, send: async () => { sends++; delivered = true; } };
  await expect(deliverDigest(saved, input, transport, async s => {
    if (!s.pending) throw new Error("disk full"); saved = structuredClone(s);
  })).rejects.toThrow();
  expect(saved.pending?.attempted).toBe(true);
  expect(await deliverDigest(saved, input, transport, async s => { saved = s; })).toBe("delivered");
  expect(sends).toBe(1);
  saved.delivered_signature = "later recommendation";
  expect(await deliverDigest(saved, { ...input, now: input.now + 1000 }, transport, async s => { saved = s; })).toBe("throttled");
});
test("checkpoint persistence failure leaves already-persisted groups and old checkpoint", async () => {
  let durable: RecordData = { last_successful_scan: "2026-10-07T00:00:00Z" };
  let saves = 0;
  await expect(saveFindings(durable, scan, findings(), async value => {
    if (++saves === 2) throw new Error("checkpoint disk failure");
    durable = structuredClone(value);
  })).rejects.toThrow();
  expect(durable.last_successful_scan).toBe("2026-10-07T00:00:00Z");
  expect(durable.groups).toEqual(findings().groups);
});
test("finishing an older resumed scan cannot regress a newer successful checkpoint", async () => {
  const writes: RecordData[] = [];
  const newer = "2026-10-09T00:00:00Z";
  await saveFindings({ last_successful_scan: newer }, scan, findings(), async s => { writes.push(s); });
  expect(writes.length).toBe(1);
  expect(writes[0]?.last_successful_scan).toBe(newer);
});
