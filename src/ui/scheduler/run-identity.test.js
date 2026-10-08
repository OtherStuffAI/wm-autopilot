import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { identityIssue, identityName, runIdentityField } from "./run-identity.js";
import { createSchedulerFormSupport } from "./form-support.js";

const identities = [{ botNpub: "npub-rick", name: "Rick" }];
test("requires a visible owned choice and surfaces loading and unavailable states", () => {
  expect(identityIssue("session", "", identities, "ready")).toContain("Choose");
  expect(identityIssue("pipeline", "npub-rick", identities, "ready")).toBe("");
  expect(identityIssue("session", "npub-retired", identities, "ready")).toContain("unavailable");
  expect(identityIssue("pipeline", "npub-rick", identities, "loading")).toContain("Loading");
  expect(identityIssue("pipeline", "npub-rick", identities, "error")).toContain("Retry");
  expect(identityIssue("cleanup", "", [], "error")).toBe("");
  expect(identityName("npub-rick", identities, "ready")).toBe("Rick");
  expect(identityName("npub-retired", identities, "ready")).toBe("Unavailable identity");
  expect(identityName("", identities, "ready")).toBe("Identity missing");
  expect(createSchedulerFormSupport({ getDefaultAgent: () => "codex" }).createFormValues().botNpub).toBe("");
});
test("create/edit controls expose inspectable npub and retain unavailable saved choice", () => {
  for (const edit of [false, true]) {
    const template = runIdentityField(edit);
    expect(template).toContain('aria-label="Run as identity"');
    expect(template).toContain('aria-live="polite"');
    expect(template).toContain("Unavailable:");
    expect(template).toContain(edit ? "editForm.botNpub" : "form.botNpub");
  }
  const page = readFileSync(new URL("./page.js", import.meta.url), "utf8");
  expect(page).toContain('botNpub: job.botNpub || ""');
  expect(page).toContain('botNpub: this.editActionType === "cleanup" ? undefined : this.editForm.botNpub');
  expect(page).toContain('botNpub: this.actionType === "cleanup" ? undefined : this.form.botNpub');
  expect(page).toContain('scheduler-saved-identity');
});
