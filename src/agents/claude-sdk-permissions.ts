import { subscribeSessionApprovalChanges, UNATTENDED_QUESTION_GUIDANCE } from "./session-approval-policy";
import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentPermission } from "./agent-adapter";

/** Keep approval inputs server-side; the browser receives only a bounded label. */
export class ClaudeSdkPermissions {
  private readonly pending = new Map<string, {
    permission: AgentPermission;
    input: Record<string, unknown>;
    tool: string;
    resolve: (result: PermissionResult) => void;
  }>();
  private wasAutoApprove = false;
  private readonly unsubscribePolicy: () => void;
  private readonly alwaysAllowed = new Set<string>();

  constructor(private readonly sessionId: string, private readonly emit: (permission: AgentPermission) => void,
    private readonly redact: (text: string) => string = (text) => text,
    private readonly autoApprove: () => boolean = () => false,
    private readonly record: (text: string) => void = () => {},
    private readonly settled: (id: string) => void = () => {}) {
    this.wasAutoApprove = this.autoApprove();
    this.unsubscribePolicy = subscribeSessionApprovalChanges(() => this.reconcilePolicy());
  }

  readonly canUseTool: CanUseTool = async (tool, input, options) => {
    if (options.signal.aborted) return { behavior: "deny", message: "Turn interrupted" };
    if (this.autoApprove()) return this.automaticResult(tool, input);
    if (this.alwaysAllowed.has(tool)) return { behavior: "allow", updatedInput: input };
    const id = randomUUID();
    const permission: AgentPermission = {
      id, sessionId: this.sessionId, type: "tool", title: this.redact(`Allow ${tool}?`),
      pattern: this.redact(JSON.stringify(input)).slice(0, 1000),
      metadata: {}, createdAt: new Date().toISOString(),
      options: [
        { optionId: "once", label: "Allow once", response: "once" },
        { optionId: "always", label: "Allow for this session", response: "always" },
        { optionId: "reject", label: "Reject", response: "reject" },
      ],
    };
    return await new Promise<PermissionResult>((resolve) => {
      const abort = () => { this.respond(id, "reject"); };
      this.pending.set(id, { permission, input, tool, resolve: (result) => {
        options.signal.removeEventListener("abort", abort);
        resolve(result);
      } });
      options.signal.addEventListener("abort", abort, { once: true });
      this.emit(permission);
    });
  };

  list(): AgentPermission[] { return [...this.pending.values()].map((value) => value.permission); }

  respond(id: string, response: "once" | "always" | "reject"): boolean {
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    this.settled(id);
    if (response === "always") this.alwaysAllowed.add(request.tool);
    request.resolve(response === "reject" ? { behavior: "deny", message: "Operator rejected tool request" }
      : { behavior: "allow", updatedInput: request.input });
    return true;
  }

  reconcilePolicy(): void {
    const enabled = this.autoApprove();
    if (this.wasAutoApprove && !enabled) this.resetToolConsent();
    this.wasAutoApprove = enabled;
    if (!enabled) return;
    for (const [id, request] of this.pending) {
      this.pending.delete(id);
      this.settled(id);
      request.resolve(this.automaticResult(request.tool, request.input));
    }
  }

  resetToolConsent(): void { this.alwaysAllowed.clear(); }

  private automaticResult(tool: string, input: Record<string, unknown>): PermissionResult {
    if (tool === "AskUserQuestion") {
      this.record("Unattended question returned to agent judgment: " + this.redact(JSON.stringify(input)) + "\n" + UNATTENDED_QUESTION_GUIDANCE);
      return { behavior: "deny", message: UNATTENDED_QUESTION_GUIDANCE };
    }
    this.record(`Session policy auto-approved provider tool: ${this.redact(tool)}.`);
    return { behavior: "allow", updatedInput: input };
  }

  dispose(): void { this.cancel(); this.unsubscribePolicy(); }

  cancel(): void { for (const id of this.pending.keys()) this.respond(id, "reject"); }
}
