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
  private readonly alwaysAllowed = new Set<string>();

  constructor(private readonly sessionId: string, private readonly emit: (permission: AgentPermission) => void,
    private readonly redact: (text: string) => string = (text) => text) {}

  readonly canUseTool: CanUseTool = async (tool, input, options) => {
    if (this.alwaysAllowed.has(tool)) return { behavior: "allow", updatedInput: input };
    if (options.signal.aborted) return { behavior: "deny", message: "Turn interrupted" };
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
    if (response === "always") this.alwaysAllowed.add(request.tool);
    request.resolve(response === "reject" ? { behavior: "deny", message: "Operator rejected tool request" }
      : { behavior: "allow", updatedInput: request.input });
    return true;
  }

  cancel(): void { for (const id of this.pending.keys()) this.respond(id, "reject"); }
}
