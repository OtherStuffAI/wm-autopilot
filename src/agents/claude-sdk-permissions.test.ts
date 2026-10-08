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
});
