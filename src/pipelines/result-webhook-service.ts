import { finalizeEvent, type EventTemplate } from "nostr-tools";
import { createHash } from "node:crypto";
import type { PipelineStore } from "./pipeline-store";
import { runEnvelope } from "./public-call-contract";
import { postResultWebhook } from "./result-webhook-http";
import { ActivityWebhookDelivery } from "./activity-webhook-delivery.ts";
import type { ActivityWebhookMonitor } from "./activity-webhook-monitor.ts";

export class ResultWebhookService {
  readonly activities: ActivityWebhookDelivery;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(private readonly store: PipelineStore, readonly pubkey: string,
    private readonly sign: (event: EventTemplate) => ReturnType<typeof finalizeEvent>,
    private readonly transport = postResultWebhook,
    private readonly now = Date.now,
    private readonly log: (error: unknown) => void = () => {},
    private readonly activityMonitor?: ActivityWebhookMonitor) {
    this.activities = new ActivityWebhookDelivery(store.activityWebhooks, sign, transport, now, log);
  }

  start(): void {
    if (this.timer) return;
    this.activities.start();
    this.activityMonitor?.start();
    this.timer = setInterval(() => { void this.tick().catch(this.log); }, 1000);
    this.timer.unref();
    void this.tick().catch(this.log);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.activities.stop(); this.activityMonitor?.stop(); }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // Concurrency is bounded to one delivery per worker; database claims cover multiple workers.
      for (const due of this.store.publicCalls.due(this.now())) {
        if (due.attempts >= due.attemptLimit) { this.store.publicCalls.exhaust(due.id); continue; }
        const run = this.store.getRun(due.runId);
        if (!run || !run.completedAt) throw new Error(`Delivery ${due.id} lacks a terminal run`);
        const payload = JSON.stringify({ deliveryId: due.id, ...runEnvelope(run) });
        const delivery = this.store.publicCalls.claim(due.id, this.now(), payload);
        if (!delivery) continue;
        try {
          const event = this.sign({ kind: 27235, content: "", created_at: Math.floor(this.now() / 1000),
            tags: [["u", delivery.url], ["method", "POST"],
              ["payload", createHash("sha256").update(delivery.payload!).digest("hex")],
              ["delivery", delivery.id], ["run", delivery.runId], ["attempt", String(delivery.attempts)]] });
          const status = await this.transport(delivery.url, delivery.payload!, {
            Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
            "X-Wingman-Delivery-Id": delivery.id, "X-Wingman-Run-Id": delivery.runId,
          });
          this.store.publicCalls.finish(delivery, { status, error: status >= 200 && status < 300 ? null : `Receiver returned HTTP ${status}` }, this.now());
        } catch (error) {
          this.store.publicCalls.finish(delivery, { status: null, error: error instanceof Error ? error.message : String(error) }, this.now());
        }
      }
    } finally { this.busy = false; }
  }
}
