import { expect, test } from "bun:test";
import { ClaudeSdkPermissions } from "./claude-sdk-permissions";

test("Claude approvals preserve inputs server-side, redact browser labels and cancel on abort", async () => {
  const permissions = new ClaudeSdkPermissions("session", () => {}, (text) => text.replaceAll("secret-token", "[redacted]"));
  const controller = new AbortController();
  const input = { command: "secret-token" };
  const approval = permissions.canUseTool("Bash", input, { signal: controller.signal, toolUseID: "tool" });
  expect(JSON.stringify(permissions.list())).not.toContain("secret-token");
  expect(permissions.respond(permissions.list()[0]!.id, "once")).toBe(true);
  expect(await approval).toMatchObject({ behavior: "allow", updatedInput: input });
  const cancelled = permissions.canUseTool("Bash", input, { signal: controller.signal, toolUseID: "other" });
  controller.abort();
  expect(await cancelled).toMatchObject({ behavior: "deny" });
  expect(permissions.list()).toHaveLength(0);
  permissions.dispose();
});

import { notifySessionApprovalChanges } from "./session-approval-policy";

test("session opt-in resolves pending and future tools, isolates sessions and reverts to manual", async () => {
  let enabled = false;
  const records: string[] = [];
  const first = new ClaudeSdkPermissions("first", () => {}, undefined, () => enabled, (text) => records.push(text));
  const second = new ClaudeSdkPermissions("second", () => {});
  const signal = new AbortController().signal;
  const options = { signal, toolUseID: "tool" };
  const waiting = first.canUseTool("Bash", { command: "echo ok" }, options);
  const other = second.canUseTool("Bash", {}, options);
  enabled = true;
  notifySessionApprovalChanges();
  expect(await waiting).toMatchObject({ behavior: "allow" });
  expect(first.list()).toHaveLength(0);
  expect(second.list()).toHaveLength(1);
  expect(await first.canUseTool("Edit", {}, options)).toMatchObject({ behavior: "allow" });
  expect(records).toHaveLength(2);
  enabled = false;
  notifySessionApprovalChanges();
  const manual = first.canUseTool("Bash", {}, options);
  expect(first.list()).toHaveLength(1);
  first.cancel(); second.cancel();
  expect(await manual).toMatchObject({ behavior: "deny" });
  expect(await other).toMatchObject({ behavior: "deny" });
  first.dispose(); second.dispose();
});

test("unattended questions return to judgment without fabricating answers or invisible input", async () => {
  let enabled = false;
  const records: string[] = [];
  const permissions = new ClaudeSdkPermissions("session", () => {}, (text) => text.replaceAll("secret", "[redacted]"),
    () => enabled, (text) => records.push(text));
  const controller = new AbortController();
  const input = { questions: [{ question: "Optional implementation choice secret?", options: [{ label: "Not now (Recommended)" }] }] };
  const waiting = permissions.canUseTool("AskUserQuestion", input, { signal: controller.signal, toolUseID: "question" });
  enabled = true; notifySessionApprovalChanges();
  const result = await waiting;
  expect(result).toMatchObject({ behavior: "deny" });
  expect(JSON.stringify(result)).toContain("record each choice");
  expect(JSON.stringify(result)).toContain("essential information");
  expect(JSON.stringify(result)).not.toContain("updatedInput");
  expect(records[0]).toContain("Not now (Recommended)");
  expect(records[0]).not.toContain("secret");
  controller.abort();
  expect(await permissions.canUseTool("Bash", {}, { signal: controller.signal, toolUseID: "aborted" })).toMatchObject({ behavior: "deny" });
  expect(permissions.list()).toHaveLength(0);
  permissions.dispose();
});

test("revoking automatic consent clears old per-tool consent and does not reapprove interrupted requests", async () => {
  let enabled = false;
  const permissions = new ClaudeSdkPermissions("session", () => {}, undefined, () => enabled);
  const controller = new AbortController();
  const options = { signal: controller.signal, toolUseID: "tool" };
  const allowed = permissions.canUseTool("Bash", {}, options);
  permissions.respond(permissions.list()[0]!.id, "always"); await allowed;
  enabled = true; notifySessionApprovalChanges();
  enabled = false; notifySessionApprovalChanges();
  const pending = permissions.canUseTool("Bash", {}, options);
  expect(permissions.list()).toHaveLength(1);
  controller.abort();
  enabled = true; notifySessionApprovalChanges();
  expect(await pending).toMatchObject({ behavior: "deny" });
  expect(permissions.list()).toHaveLength(0);
  permissions.dispose();
});
