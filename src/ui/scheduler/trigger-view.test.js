import { describe, expect, test } from "bun:test";

import {
  countJobs, describeDraft, describeJobWhat, describeJobWhen, filterJobs,
  firstInvalidField, jobStatus, validateTriggerForm,
} from "./trigger-view.js";
import { describeSchedule, isValidTimezone } from "./schedule-helpers.js";

const goodForm = () => ({
  name: "Daily review", workingDirectory: "/work", initialPrompt: "Review", pipelineDefinitionId: "",
  pipelineInput: "{}", timezone: "Europe/London", watchDirectory: "", filePattern: "*",
  activeStartTime: "", activeEndTime: "",
});

const jobs = [
  { id: "1", name: "Morning review", enabled: true, triggerType: "cron", cronExpression: "0 9 * * *", timezone: "UTC", workingDirectory: "/repo/app", agent: "codex", initialPrompt: "check" },
  { id: "2", name: "Inbox watcher", enabled: false, triggerType: "file_watcher", watchDirectory: "/inbox", filePattern: "*.json", actionType: "pipeline", pipelineDefinitionId: "p1" },
  { id: "3", name: "Old relay", enabled: false, triggerType: "unsupported" },
];

describe("timezone and schedule text", () => {
  test("validates IANA names", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mars/Base")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  test("attaches the timezone to the readable schedule", () => {
    expect(describeSchedule("0 9 * * 1-5", "Europe/London")).toBe("Weekdays at 09:00 (Europe/London)");
    expect(describeSchedule("*/5 * * * *", "")).toBe("Every 5 minutes");
  });
});

describe("validateTriggerForm", () => {
  test("accepts a complete session schedule", () => {
    expect(validateTriggerForm({ actionType: "session", triggerType: "cron", form: goodForm() })).toEqual({});
  });

  test("reports each missing session field by key", () => {
    const form = { ...goodForm(), name: " ", workingDirectory: "", initialPrompt: "", timezone: "Nope/Zone" };
    const errors = validateTriggerForm({ actionType: "session", triggerType: "cron", form, identityMessage: "Choose a Run as identity." });
    expect(Object.keys(errors).sort()).toEqual(["botNpub", "initialPrompt", "name", "timezone", "workingDirectory"]);
    expect(firstInvalidField(errors)).toBe("name");
  });

  test("pipeline needs a definition and a JSON object input", () => {
    const base = { ...goodForm(), pipelineDefinitionId: "p1" };
    expect(validateTriggerForm({ actionType: "pipeline", triggerType: "cron", form: base })).toEqual({});
    expect(validateTriggerForm({ actionType: "pipeline", triggerType: "cron", form: { ...base, pipelineInput: "[1]" } }).pipelineInput).toMatch(/JSON object/);
    expect(validateTriggerForm({ actionType: "pipeline", triggerType: "cron", form: { ...base, pipelineInput: "{oops" } }).pipelineInput).toMatch(/not valid JSON/);
    expect(validateTriggerForm({ actionType: "pipeline", triggerType: "cron", form: { ...base, pipelineDefinitionId: "" } }).pipelineDefinitionId).toBeTruthy();
  });

  test("file watcher needs a directory; timezone only matters with a window", () => {
    const form = { ...goodForm(), timezone: "bad" };
    expect(validateTriggerForm({ actionType: "session", triggerType: "file_watcher", form }).watchDirectory).toBeTruthy();
    expect(validateTriggerForm({ actionType: "session", triggerType: "file_watcher", form: { ...form, watchDirectory: "/w" } })).toEqual({});
    const windowed = { ...form, watchDirectory: "/w", activeStartTime: "09:00", activeEndTime: "17:00" };
    expect(validateTriggerForm({ actionType: "session", triggerType: "file_watcher", form: windowed }).timezone).toBeTruthy();
  });

  test("cleanup needs only a name and timezone, and an active window needs both ends", () => {
    const form = { ...goodForm(), workingDirectory: "", initialPrompt: "" };
    expect(validateTriggerForm({ actionType: "cleanup", triggerType: "cron", form })).toEqual({});
    expect(validateTriggerForm({ actionType: "cleanup", triggerType: "cron", form: { ...form, activeStartTime: "09:00" } }).activeWindow).toBeTruthy();
  });
});

describe("summaries and filtering", () => {
  test("describes saved jobs in plain language", () => {
    expect(describeJobWhen(jobs[0])).toBe("Daily at 09:00 (UTC)");
    expect(describeJobWhen(jobs[1])).toBe("When files change in /inbox matching *.json");
    expect(describeJobWhat(jobs[1], () => "Digest")).toBe("Pipeline: Digest");
    expect(describeJobWhat(jobs[0])).toBe("Agent session (codex) in /repo/app");
    expect(jobStatus(jobs[2]).key).toBe("unsupported");
  });

  test("filters by text, status and type, and counts by status", () => {
    expect(filterJobs(jobs, { query: "review" }).map((j) => j.id)).toEqual(["1"]);
    expect(filterJobs(jobs, { query: "daily at 09" }).map((j) => j.id)).toEqual(["1"]);
    expect(filterJobs(jobs, { status: "disabled" }).map((j) => j.id)).toEqual(["2"]);
    expect(filterJobs(jobs, { type: "file_watcher", status: "disabled" }).map((j) => j.id)).toEqual(["2"]);
    expect(filterJobs(jobs, { query: "ada" }, (job) => (job.id === "1" ? "Ada Bot" : "")).map((j) => j.id)).toEqual(["1"]);
    expect(countJobs(jobs)).toEqual({ total: 3, enabled: 1, disabled: 1, unsupported: 1 });
  });

  test("draft summary reads as one sentence", () => {
    const text = describeDraft({ actionType: "session", triggerType: "cron", form: { ...goodForm(), activeStartTime: "09:00", activeEndTime: "17:00" }, cronExpression: "0 9 * * 1-5", identityName: "Ada" });
    expect(text).toBe("Weekdays at 09:00 (Europe/London) → start an agent session as Ada. Only between 09:00 and 17:00 (Europe/London).");
  });
});
