import { readBoundTurnActivity } from "../agents/bound-turn-activity.ts";
import type { SessionApiContext } from "../server/session-api-routes.ts";
import type { PipelineStore } from "./pipeline-store.ts";
import type { ActivityTurnBinding } from "./activity-webhook-store.ts";

/** Reconstruct monitors from durable bindings; no pipeline SSE or model-selected routing. */
export class ActivityWebhookMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private offset = 0;
  private warned = new Set<string>();
  constructor(private readonly store: PipelineStore, private readonly ctx: SessionApiContext,
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
      const active = this.store.activityWebhooks.active();
      if (!active.length) return;
      const bindings = [...active.slice(this.offset), ...active.slice(0, this.offset)].slice(0, 2);
      this.offset = (this.offset + bindings.length) % active.length;
      for (const binding of bindings) await this.observe(binding);
    } finally { this.busy = false; }
  }
  async observe(binding: ActivityTurnBinding): Promise<void> {
    const receipt = binding.receiptId ? this.store.completedTurns.get(binding.receiptId) : null;
    const step = this.store.getStep(binding.stepId);
    const run = this.store.getRun(binding.runId);
    const replaced = !binding.receiptId && step?.wingmanSessionId !== binding.sessionId;
    const terminal = binding.receiptId ? receipt?.status === "completed" || receipt?.status === "uncertain" || receipt?.status === "abandoned" : step?.status !== "running" || replaced;
    const success = binding.receiptId ? receipt?.status === "completed" : step?.status === "ok" && !replaced;
    try {
      if (!binding.sessionId) throw new Error("Activity source has no host session (isolated execution)");
      const session = this.ctx.manager.getSession(binding.sessionId) ?? this.ctx.messageStore.getSession(binding.sessionId)
        ?? this.ctx.sessionArchiveStore?.getArchivedSession(binding.sessionId);
      if (!session) throw new Error("Activity bound session unavailable");
      const native = session.metadata?.nativeAgentSession;
      if (native?.agent === "codex" && native.sessionId && session.workingDirectory) {
        if (receipt?.nativeSessionId && receipt.nativeSessionId !== native.sessionId) throw new Error("Activity receipt native conversation mismatch");
        this.store.activityWebhooks.bindNative(binding.turnId, native.sessionId);
        const projection = await readBoundTurnActivity({ nativeSessionId: native.sessionId, directory: session.workingDirectory }, binding.checkpoint, binding.prompt);
        for (const activity of projection.activities) this.store.activityWebhooks.append(binding, activity);
      } else if (session.agent !== "codex") {
        const adapter = this.ctx.manager.getAdapter(binding.sessionId);
        if (!adapter) throw new Error("Activity adapter unavailable");
        const messages = await adapter.fetchMessages(750);
        let users = 0;
        let active = false;
        let tools = false;
        for (const [index, message] of messages.entries()) {
          if (message.role === "user") {
            users++;
            if (users <= binding.checkpoint) continue;
            if (active) break;
            if (users !== binding.checkpoint + 1 || message.content !== binding.prompt) throw new Error("Activity adapter prompt boundary mismatch");
            active = true;
          } else if (active && message.role === "agent-commentary" && message.content.trim()) {
            this.store.activityWebhooks.append(binding, { sourceId: String(message.messageId ?? index), timestamp: message.createdAt,
              type: "commentary", content: message.content.replace(/\0/g, "").trim().slice(0, 4000) });
            tools = false;
          } else if (active && message.role === "agent-tools") {
            if (!tools) this.store.activityWebhooks.append(binding, { sourceId: String(message.messageId ?? index), timestamp: message.createdAt, type: "tools", content: "Using tools" });
            tools = true;
          }
        }
      } else throw new Error("Activity native transcript binding not available yet");
    } catch (error) {
      if (!this.warned.has(binding.turnId)) {
        this.warned.add(binding.turnId);
        this.store.addEvent({ runId: binding.runId, stepId: binding.stepId, level: "warn", type: "activity_source_unavailable",
          message: error instanceof Error ? error.message : "Activity source unavailable", data: { turnId: binding.turnId } });
      }
    }
    if (terminal || !run || run.status !== "running") {
      this.store.activityWebhooks.finish(binding, Boolean(success));
      this.warned.delete(binding.turnId);
    }
  }
}
