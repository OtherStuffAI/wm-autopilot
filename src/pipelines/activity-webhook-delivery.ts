import { createHash } from "node:crypto";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { postResultWebhook } from "./result-webhook-http.ts";
import type { ActivityWebhookStore } from "./activity-webhook-store.ts";
import type { ActivityWebhookEvent } from "./activity-webhook-contract.ts";

export function activityAuthTemplate(url: string, body: string, now: number): EventTemplate {
  const event = JSON.parse(body) as ActivityWebhookEvent;
  return { kind: 27235, content: "", created_at: Math.floor(now / 1000),
    tags: [["u", url], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")],
      ["event", event.eventId], ["run", event.runId]] };
}

/** Own timer and concurrency budget: neither progress nor final callbacks wait for each other. */
export class ActivityWebhookDelivery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  constructor(private readonly store: ActivityWebhookStore,
    private readonly sign: (event: EventTemplate) => VerifiedEvent,
    private readonly transport = postResultWebhook, private readonly now = Date.now,
    private readonly log: (error: unknown) => void = () => {}) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(this.log); }, 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // At most two independent turns in flight, and one event per turn.
      await Promise.all(this.store.due(this.now()).slice(0, 2).map(async due => {
        if (due.attempts >= 3) { this.store.exhaust(due.eventId); return; }
        const delivery = this.store.claim(due.eventId, this.now());
        if (!delivery) return;
        let status: number | null = null;
        try {
          const signed = this.sign(activityAuthTemplate(delivery.url, delivery.body, this.now()));
          const event = JSON.parse(delivery.body) as ActivityWebhookEvent;
          status = await this.transport(delivery.url, delivery.body, {
            Authorization: `Nostr ${Buffer.from(JSON.stringify(signed)).toString("base64")}`,
            "X-Wingman-Event-Id": event.eventId, "X-Wingman-Run-Id": event.runId,
          });
        } catch { /* Persist a bounded, non-sensitive delivery failure below. */ }
        this.store.settle(delivery, status, this.now());
      }));
    } finally { this.busy = false; }
  }
}
